import { Inject, Injectable } from '@nestjs/common';
import type { Account } from '.prisma/portal-auth-client';
import {
  checkLoginResponse,
  checkTotpStep,
  createLoginOptions,
  findMatchingRecoveryCode,
  isNewerTotpStep,
  normalizeCode,
  normalizeTotpCode,
  verifyAgainstDummy,
  verifyPasswordOrFalse,
  withMinDuration,
  type AuthenticationResponseJSON,
} from '@saas-instant/auth-core';
import { AuditService } from '../audit/audit.service';
import { ApiError, invalidCredentials } from '../common/errors';
import { CONFIG, PortalConfig } from '../config';
import { PrismaService } from '../prisma.service';
import { SessionsService, SessionView } from '../sessions/sessions.service';
import { AccountsService } from '../accounts/accounts.service';
import { normalizeEmail } from '../accounts/password-policy';
import { LockoutService } from './lockout.service';

/** Antwortzeit der Anmeldung nie unter diesem Wert (verdeckt, ob ein Konto existiert). */
export const LOGIN_MIN_DURATION_MS = 350;
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface LoginContext {
  ip: string | null;
  /** Bestehende Sitzung des Browsers, falls vorhanden (Step-up). */
  current: SessionView | null;
  /** Wartende Authorize-Anfrage, falls die Anmeldung dazu gehört. */
  reqId?: string;
}

export interface LoginResult {
  token: string;
  sessionId: string;
  next: string;
  amr: string[];
}

@Injectable()
export class LoginService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly lockout: LockoutService,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    @Inject(CONFIG) private readonly config: PortalConfig,
  ) {}

  async login(input: { email: string; password: string; code?: string }, ctx: LoginContext): Promise<LoginResult> {
    return withMinDuration(LOGIN_MIN_DURATION_MS, () => this.loginInner(input, ctx));
  }

  private async loginInner(input: { email: string; password: string; code?: string }, ctx: LoginContext): Promise<LoginResult> {
    const email = normalizeEmail(input.email);
    const account = await this.prisma.account.findUnique({ where: { email } });
    if (!account || !account.passwordHash || account.disabledAt) {
      await verifyAgainstDummy(input.password);
      await this.audit.log({ action: 'login.failed', ip: ctx.ip, detail: { reason: account ? 'unavailable' : 'unknown' } });
      throw invalidCredentials();
    }
    const locked = this.lockout.remainingSeconds(account.lockedUntil);
    if (locked > 0) throw this.lockedError(locked);

    if (!(await verifyPasswordOrFalse(account.passwordHash, input.password))) {
      await this.fail(account, ctx.ip, 'password');
    }
    if (!account.totpSecret) throw new ApiError(403, 'setup_required', 'Die Einrichtung des Kontos ist nicht abgeschlossen.');
    if (!input.code || !input.code.trim()) {
      throw new ApiError(401, 'code_required', 'Bitte den Code aus der Authenticator-App eingeben.');
    }
    if (!(await this.checkSecondFactor(account, input.code))) await this.fail(account, ctx.ip, 'code');

    await this.lockout.reset(account.id);
    return this.finish(account, ['pwd', 'otp'], ctx);
  }

  private lockedError(seconds: number): ApiError {
    return new ApiError(429, 'account_locked', 'Das Konto ist vorübergehend gesperrt.', { retryAfterSeconds: seconds });
  }

  private async fail(account: Account, ip: string | null, factor: 'password' | 'code'): Promise<never> {
    const seconds = await this.lockout.recordFailure(account.id, ip);
    await this.audit.log({ action: 'login.failed', accountId: account.id, ip, detail: { factor } });
    if (seconds > 0) throw this.lockedError(seconds);
    throw invalidCredentials();
  }

  /** TOTP (einmalig je Zeitschritt, atomar) oder Wiederherstellungscode (einmalig). */
  private async checkSecondFactor(account: Account, rawCode: string): Promise<boolean> {
    const totpCode = normalizeTotpCode(rawCode);
    if (totpCode) {
      const step = checkTotpStep(this.accounts.crypto.decrypt(account.totpSecret!), totpCode);
      if (step === null || !isNewerTotpStep(step, account.totpLastStep)) return false;
      // Atomar: nur ein größerer Schritt als der gespeicherte wird übernommen.
      const claimed = await this.prisma.account.updateMany({
        where: { id: account.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
        data: { totpLastStep: step },
      });
      return claimed.count === 1;
    }
    const open = await this.prisma.recoveryCode.findMany({ where: { accountId: account.id, consumedAt: null } });
    const match = await findMatchingRecoveryCode(open, normalizeCode(rawCode));
    if (!match) return false;
    const consumed = await this.prisma.recoveryCode.updateMany({
      where: { id: match.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count === 1) await this.audit.log({ action: 'login.recovery_code_used', accountId: account.id });
    return consumed.count === 1;
  }

  // -------- Passkey ---------------------------------------------------------

  /** Optionen für die Passkey-Anmeldung (auffindbar, ohne Kontoangabe). */
  async passkeyOptions() {
    const options = await createLoginOptions(this.config.rpId, []);
    const row = await this.prisma.webauthnChallenge.create({
      data: { challenge: options.challenge, purpose: 'login', expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) },
    });
    return { options, challengeId: row.id };
  }

  async passkeyLogin(input: { challengeId: string | undefined; response: AuthenticationResponseJSON }, ctx: LoginContext): Promise<LoginResult> {
    return withMinDuration(LOGIN_MIN_DURATION_MS, async () => {
      const deny = async (reason: string, accountId?: string): Promise<never> => {
        await this.audit.log({ action: 'login.failed', accountId, ip: ctx.ip, detail: { factor: 'passkey', reason } });
        throw invalidCredentials();
      };
      const challenge = input.challengeId
        ? await this.prisma.webauthnChallenge.findUnique({ where: { id: input.challengeId } })
        : null;
      if (challenge) await this.prisma.webauthnChallenge.deleteMany({ where: { id: challenge.id } }); // einmalig
      if (!challenge || challenge.purpose !== 'login' || challenge.expiresAt <= new Date()) return deny('challenge');
      const passkey = await this.prisma.passkey.findUnique({
        where: { credentialId: String(input.response?.id ?? '') },
        include: { account: true },
      });
      if (!passkey || passkey.account.disabledAt) return deny('unknown_passkey', passkey?.accountId);
      const verified = await checkLoginResponse(input.response, challenge.challenge, passkey, {
        rpId: this.config.rpId,
        origin: this.config.origin,
      });
      if (!verified) return deny('verification', passkey.accountId);
      await this.prisma.passkey.update({
        where: { id: passkey.id },
        data: { counter: verified.newCounter, lastUsedAt: new Date() },
      });
      return this.finish(passkey.account, ['hwk'], ctx);
    });
  }

  // -------- gemeinsamer Abschluss ----------------------------------------------

  /**
   * Faktor ist nachgewiesen: Sitzung anlegen oder (gleiches Konto, Step-up) die
   * bestehende auffrischen. Gehört die Anmeldung zu einer Authorize-Anfrage,
   * zeigt `next` dorthin zurück.
   */
  private async finish(account: Account, amr: string[], ctx: LoginContext): Promise<LoginResult> {
    let next = '/';
    if (ctx.reqId) {
      const request = await this.prisma.authRequest.findUnique({ where: { id: ctx.reqId } });
      if (!request || request.consumedAt || request.expiresAt <= new Date()) {
        throw new ApiError(410, 'auth_request_expired', 'Die Anmeldeanfrage ist abgelaufen. Bitte in der Verwaltung neu starten.');
      }
      if (request.expectedAccountId && request.expectedAccountId !== account.id) {
        throw new ApiError(403, 'step_up_wrong_account', 'Für die erneute Bestätigung muss dasselbe Konto verwendet werden.');
      }
      next = `/oauth/authorize/continue?req=${encodeURIComponent(request.id)}`;
    }
    await this.prisma.account.update({ where: { id: account.id }, data: { lastLoginAt: new Date() } });
    const now = new Date();
    if (ctx.current && ctx.current.account.id === account.id) {
      const refreshed = await this.sessions.refreshFactor(ctx.current.session.id, amr, now);
      await this.audit.log({ action: 'login.step_up', accountId: account.id, ip: ctx.ip, detail: { amr } });
      return { token: refreshed.token, sessionId: refreshed.session.id, next, amr };
    }
    if (ctx.current) await this.sessions.revoke(ctx.current.session.id, now);
    const created = await this.sessions.create(account, amr, now);
    await this.audit.log({ action: 'login.succeeded', accountId: account.id, ip: ctx.ip, detail: { amr } });
    return { token: created.token, sessionId: created.session.id, next, amr };
  }
}
