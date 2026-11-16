import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { IsObject, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import {
  checkRegistrationResponse,
  createRegistrationOptions,
  generateRecoveryCodes,
  hashPassword,
  verifyPasswordOrFalse,
  type RegistrationResponseJSON,
} from '@saas-instant/auth-core';
import type { Account } from '.prisma/portal-auth-client';
import { AccountsService } from '../accounts/accounts.service';
import { passwordProblem } from '../accounts/password-policy';
import { AuditService } from '../audit/audit.service';
import { LockoutService } from '../auth/lockout.service';
import { CHALLENGE_TTL_MS } from '../auth/login.service';
import { clearCookie, clientIp, cookieNames, readCookie } from '../common/cookies';
import { ApiError, badRequest, notFound } from '../common/errors';
import { RateLimit, SessionGuard } from '../common/guards';
import { CONFIG, PortalConfig } from '../config';
import { PrismaService } from '../prisma.service';
import { SessionsService } from '../sessions/sessions.service';

class PasswordDto {
  @IsString() @MaxLength(200) password!: string;
}
class ChangePasswordDto {
  @IsString() @MaxLength(200) currentPassword!: string;
  @IsString() @MaxLength(200) newPassword!: string;
}
class CodeDto {
  @IsString() @MaxLength(64) code!: string;
}
class PasskeyRegisterDto {
  @IsObject() response!: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(60) label?: string;
}
class IdParam {
  @IsUUID() id!: string;
}

@Controller('api/me')
@UseGuards(SessionGuard)
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly sessions: SessionsService,
    private readonly lockout: LockoutService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: PortalConfig,
  ) {}

  /** Wer bin ich, was darf ich, welche Faktoren sind eingerichtet? Grundlage des Launchers. */
  @Get()
  async me(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { account, session } = req.portal!;
    res.setHeader('Cache-Control', 'no-store');
    const [roles, passkeys, codesLeft] = await Promise.all([
      this.accounts.rolesOf(account.id),
      this.prisma.passkey.findMany({ where: { accountId: account.id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.recoveryCode.count({ where: { accountId: account.id, consumedAt: null } }),
    ]);
    return {
      account: { id: account.id, email: account.email, name: account.name, portalAdmin: account.portalAdmin },
      roles,
      session: { authTime: Math.floor(session.authTime.getTime() / 1000), amr: session.amr },
      factors: {
        totp: !!account.totpSecret,
        recoveryCodesLeft: codesLeft,
        passkeys: passkeys.map((p) => ({
          id: p.id,
          label: p.label,
          createdAt: p.createdAt,
          lastUsedAt: p.lastUsedAt,
        })),
      },
    };
  }

  /** Aktuelles Passwort verlangen; ein Fehlversuch zählt wie bei der Anmeldung. */
  private async requirePassword(account: Account, password: string, ip: string): Promise<void> {
    const remaining = this.lockout.remainingSeconds(account.lockedUntil);
    if (remaining > 0) throw new ApiError(429, 'account_locked', 'Das Konto ist vorübergehend gesperrt.', { retryAfterSeconds: remaining });
    if (account.passwordHash && (await verifyPasswordOrFalse(account.passwordHash, password))) return;
    const seconds = await this.lockout.recordFailure(account.id, ip);
    await this.audit.log({ action: 'account.password_check_failed', accountId: account.id, ip });
    if (seconds > 0) throw new ApiError(429, 'account_locked', 'Das Konto ist vorübergehend gesperrt.', { retryAfterSeconds: seconds });
    throw new ApiError(403, 'password_wrong', 'Das aktuelle Passwort stimmt nicht.');
  }

  @Post('password')
  @HttpCode(200)
  @RateLimit('me-secret', 20)
  async changePassword(@Body() dto: ChangePasswordDto, @Req() req: Request) {
    const { account: self } = req.portal!;
    await this.requirePassword(self, dto.currentPassword, clientIp(req));
    const { session } = req.portal!;
    const account = self;
    const problem = passwordProblem(dto.newPassword, account.email);
    if (problem) throw badRequest('password_weak', problem);
    await this.prisma.account.update({ where: { id: account.id }, data: { passwordHash: await hashPassword(dto.newPassword) } });
    const ended = await this.sessions.revokeAllOf(account.id, session.id);
    await this.audit.log({ action: 'account.password_changed', accountId: account.id, ip: clientIp(req), detail: { otherSessionsEnded: ended } });
    return { ok: true };
  }

  // -------- TOTP ------------------------------------------------------------------

  @Post('totp/begin')
  @HttpCode(200)
  @RateLimit('me-secret', 20)
  async totpBegin(@Body() dto: PasswordDto, @Req() req: Request) {
    const { account: self } = req.portal!;
    await this.requirePassword(self, dto.password, clientIp(req));
    const totp = await this.accounts.stagePendingTotp(self);
    return { totpSecret: totp.secretBase32, otpauthUrl: totp.otpauthUrl, qrDataUrl: totp.qrDataUrl };
  }

  @Post('totp/confirm')
  @HttpCode(200)
  @RateLimit('me-secret', 20)
  async totpConfirm(@Body() dto: CodeDto, @Req() req: Request) {
    const { account, session } = req.portal!;
    const fresh = await this.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    const { secretBase32, step } = this.accounts.confirmPendingTotp(fresh, dto.code);
    const { codes, hashes } = await generateRecoveryCodes();
    await this.prisma.$transaction([
      this.prisma.account.update({
        where: { id: account.id },
        data: {
          totpSecret: this.accounts.crypto.encrypt(secretBase32),
          totpSecretPending: null,
          totpPendingValidUntil: null,
          totpLastStep: step,
        },
      }),
      this.prisma.recoveryCode.deleteMany({ where: { accountId: account.id } }),
      this.prisma.recoveryCode.createMany({ data: hashes.map((codeHash) => ({ accountId: account.id, codeHash })) }),
    ]);
    await this.sessions.revokeAllOf(account.id, session.id);
    await this.audit.log({ action: 'account.totp_replaced', accountId: account.id, ip: clientIp(req) });
    return { ok: true, recoveryCodes: codes };
  }

  @Post('recovery-codes')
  @HttpCode(200)
  @RateLimit('me-secret', 20)
  async regenerateRecovery(@Body() dto: PasswordDto, @Req() req: Request) {
    const { account: self } = req.portal!;
    await this.requirePassword(self, dto.password, clientIp(req));
    const accountId = self.id;
    const { codes, hashes } = await generateRecoveryCodes();
    await this.prisma.$transaction([
      this.prisma.recoveryCode.deleteMany({ where: { accountId } }),
      this.prisma.recoveryCode.createMany({ data: hashes.map((codeHash) => ({ accountId, codeHash })) }),
    ]);
    await this.audit.log({ action: 'account.recovery_codes_regenerated', accountId, ip: clientIp(req) });
    return { ok: true, recoveryCodes: codes };
  }

  // -------- Passkeys ----------------------------------------------------------------

  @Post('passkeys/options')
  @HttpCode(200)
  @RateLimit('me-secret', 20)
  async passkeyOptions(@Body() dto: PasswordDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { account: self } = req.portal!;
    await this.requirePassword(self, dto.password, clientIp(req));
    const account = self;
    const existing = await this.prisma.passkey.findMany({ where: { accountId: account.id } });
    const options = await createRegistrationOptions({
      rpName: this.config.rpName,
      rpId: this.config.rpId,
      user: { id: account.id, email: account.email, name: account.name },
      existing,
    });
    const row = await this.prisma.webauthnChallenge.create({
      data: { challenge: options.challenge, purpose: 'register', accountId: account.id, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) },
    });
    res.cookie(cookieNames(this.config).challenge, row.id, {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: CHALLENGE_TTL_MS,
    });
    return options;
  }

  @Post('passkeys')
  @HttpCode(200)
  @RateLimit('me-secret', 20)
  async passkeyRegister(@Body() dto: PasskeyRegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { account } = req.portal!;
    const name = cookieNames(this.config).challenge;
    const id = readCookie(req, name);
    const challenge = id ? await this.prisma.webauthnChallenge.findUnique({ where: { id } }) : null;
    if (challenge) await this.prisma.webauthnChallenge.deleteMany({ where: { id: challenge.id } });
    clearCookie(res, this.config, name);
    if (!challenge || challenge.purpose !== 'register' || challenge.accountId !== account.id || challenge.expiresAt <= new Date()) {
      throw new ApiError(400, 'challenge_invalid', 'Die Registrierung ist abgelaufen. Bitte neu beginnen.');
    }
    const verified = await checkRegistrationResponse(dto.response as unknown as RegistrationResponseJSON, challenge.challenge, {
      rpId: this.config.rpId,
      origin: this.config.origin,
    });
    if (!verified) throw new ApiError(400, 'passkey_invalid', 'Der Passkey konnte nicht geprüft werden.');
    if (await this.prisma.passkey.findUnique({ where: { credentialId: verified.credentialId } })) {
      throw new ApiError(409, 'passkey_exists', 'Dieser Passkey ist schon registriert.');
    }
    const created = await this.prisma.passkey.create({
      data: {
        accountId: account.id,
        credentialId: verified.credentialId,
        publicKey: verified.publicKeyBase64,
        counter: verified.counter,
        transports: verified.transports,
        label: (dto.label ?? '').trim() || 'Passkey',
      },
    });
    await this.audit.log({ action: 'account.passkey_added', accountId: account.id, ip: clientIp(req) });
    return { ok: true, id: created.id };
  }

  @Post('passkeys/:id/delete')
  @HttpCode(200)
  @RateLimit('me-secret', 20)
  async passkeyDelete(@Param() params: IdParam, @Body() dto: PasswordDto, @Req() req: Request) {
    const { account: self } = req.portal!;
    await this.requirePassword(self, dto.password, clientIp(req));
    const removed = await this.prisma.passkey.deleteMany({ where: { id: params.id, accountId: self.id } });
    if (removed.count !== 1) throw notFound('Passkey nicht gefunden.');
    await this.audit.log({ action: 'account.passkey_removed', accountId: self.id, ip: clientIp(req) });
    return { ok: true };
  }
}
