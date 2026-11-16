import { Inject, Injectable } from '@nestjs/common';
import type { Account } from '.prisma/portal-auth-client';
import * as QRCode from 'qrcode';
import {
  checkTotpStep,
  createTotpSetup,
  generateRecoveryCodes,
  generateToken,
  hashPassword,
  hashToken,
  isNewerTotpStep,
  isTotpPendingExpired,
  normalizeTotpCode,
  totpPendingValidUntil,
  type TotpSetup,
} from '@saas-instant/auth-core';
import { ApiError, badRequest, notFound } from '../common/errors';
import { FieldCrypto } from '../common/field-crypto';
import { CONFIG, PortalConfig } from '../config';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { normalizeEmail, passwordProblem } from './password-policy';

export const SETUP_TOKEN_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export type Role = 'admin' | 'staff';
export const ROLES: readonly Role[] = ['admin', 'staff'];

export interface TotpBegin extends TotpSetup {
  qrDataUrl: string;
}

@Injectable()
export class AccountsService {
  readonly crypto: FieldCrypto;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionsService,
    @Inject(CONFIG) private readonly config: PortalConfig,
  ) {
    this.crypto = new FieldCrypto(config.keySecret);
  }

  setupLink(token: string): string {
    return `${this.config.issuer}/auth/setup?token=${encodeURIComponent(token)}`;
  }

  /** Legt ein Konto ohne Passwort an und stellt den Einrichtungslink aus. */
  async create(input: { email: string; name: string; portalAdmin?: boolean }, actor?: string | null): Promise<{ account: Account; link: string }> {
    const email = normalizeEmail(input.email);
    const name = input.name.trim();
    if (!email || !name) throw badRequest('invalid_request', 'E-Mail und Name sind nötig.');
    if (await this.prisma.account.findUnique({ where: { email } })) {
      throw new ApiError(409, 'email_taken', 'Zu dieser E-Mail-Adresse gibt es schon ein Konto.');
    }
    const account = await this.prisma.account.create({
      data: { email, name, portalAdmin: input.portalAdmin ?? false },
    });
    await this.audit.log({ action: 'account.created', accountId: account.id, detail: { by: actor ?? 'cli' } });
    const link = await this.issueSetupLink(account.id, 'setup');
    return { account, link };
  }

  /** Neuer Einrichtungs-/Zurücksetzungslink; ältere offene Links werden ungültig. */
  async issueSetupLink(accountId: string, purpose: 'setup' | 'reset', now: Date = new Date()): Promise<string> {
    await this.prisma.setupToken.deleteMany({ where: { accountId, consumedAt: null } });
    const token = generateToken();
    await this.prisma.setupToken.create({
      data: { accountId, tokenHash: hashToken(token), purpose, expiresAt: new Date(now.getTime() + SETUP_TOKEN_TTL_MS) },
    });
    return this.setupLink(token);
  }

  private async openToken(token: string, now: Date) {
    const row = await this.prisma.setupToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { account: true },
    });
    if (!row || row.consumedAt || row.expiresAt <= now || row.account.disabledAt) {
      throw new ApiError(410, 'setup_link_invalid', 'Der Einrichtungslink ist ungültig oder abgelaufen.');
    }
    return row;
  }

  /** Beginnt die Einrichtung: vorläufiges TOTP-Geheimnis am Konto, QR-Code für die App. */
  async beginSetup(token: string, now: Date = new Date()) {
    const row = await this.openToken(token, now);
    const totp = await this.stagePendingTotp(row.account, now);
    return { email: row.account.email, name: row.account.name, purpose: row.purpose, totp };
  }

  async stagePendingTotp(account: Account, now: Date = new Date()): Promise<TotpBegin> {
    const setup = createTotpSetup(account.email, this.config.totpIssuer);
    await this.prisma.account.update({
      where: { id: account.id },
      data: {
        totpSecretPending: this.crypto.encrypt(setup.secretBase32),
        totpPendingValidUntil: totpPendingValidUntil(now),
      },
    });
    return { ...setup, qrDataUrl: await QRCode.toDataURL(setup.otpauthUrl, { margin: 1, width: 220 }) };
  }

  /** Prüft den Code gegen das vorläufige Geheimnis; liefert Geheimnis und Zeitschritt. */
  confirmPendingTotp(account: Account, code: string, now: Date = new Date()): { secretBase32: string; step: number } {
    if (!account.totpSecretPending || isTotpPendingExpired(account.totpPendingValidUntil, now)) {
      throw new ApiError(409, 'totp_pending_expired', 'Die Einrichtung ist abgelaufen. Bitte neu beginnen.');
    }
    const normalized = normalizeTotpCode(code);
    const secretBase32 = this.crypto.decrypt(account.totpSecretPending);
    const step = normalized ? checkTotpStep(secretBase32, normalized, now) : null;
    if (step === null) throw new ApiError(400, 'totp_code_invalid', 'Der Code stimmt nicht. Bitte erneut versuchen.');
    return { secretBase32, step };
  }

  /** Schließt die Einrichtung ab: Passwort, TOTP, Wiederherstellungscodes. Der Link gilt einmal. */
  async completeSetup(input: { token: string; password: string; code: string }, ip: string | null, now: Date = new Date()) {
    const row = await this.openToken(input.token, now);
    const account = row.account;
    const problem = passwordProblem(input.password, account.email);
    if (problem) throw badRequest('password_weak', problem);
    const { secretBase32, step } = this.confirmPendingTotp(account, input.code, now);
    const passwordHash = await hashPassword(input.password);
    const { codes, hashes } = await generateRecoveryCodes();

    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.setupToken.updateMany({
        where: { id: row.id, consumedAt: null },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) throw new ApiError(410, 'setup_link_invalid', 'Der Einrichtungslink ist ungültig oder abgelaufen.');
      await tx.account.update({
        where: { id: account.id },
        data: {
          passwordHash,
          totpSecret: this.crypto.encrypt(secretBase32),
          totpSecretPending: null,
          totpPendingValidUntil: null,
          totpLastStep: step,
          failedAttempts: 0,
          lockedUntil: null,
        },
      });
      await tx.recoveryCode.deleteMany({ where: { accountId: account.id } });
      await tx.recoveryCode.createMany({ data: hashes.map((codeHash) => ({ accountId: account.id, codeHash })) });
      if (row.purpose === 'reset') await tx.passkey.deleteMany({ where: { accountId: account.id } });
    });
    if (row.purpose === 'reset') await this.sessions.revokeAllOf(account.id, undefined, now);
    await this.audit.log({ action: `account.${row.purpose}_completed`, accountId: account.id, ip });
    return { recoveryCodes: codes };
  }

  /** Setzt die Rolle eines Kontos in einer Verwaltung; `none` entzieht sie. */
  async setRole(accountId: string, clientId: string, role: Role | 'none', actor?: string | null): Promise<void> {
    if (role !== 'none' && !ROLES.includes(role)) throw badRequest('invalid_role', 'Rolle muss admin, staff oder none sein.');
    const account = await this.prisma.account.findUnique({ where: { id: accountId } });
    if (!account) throw notFound('Konto nicht gefunden.');
    const client = await this.prisma.oidcClient.findUnique({ where: { id: clientId } });
    if (!client) throw notFound(`Verwaltung "${clientId}" ist nicht registriert.`);
    if (role === 'none') {
      await this.prisma.accountRole.deleteMany({ where: { accountId, clientId } });
    } else {
      await this.prisma.accountRole.upsert({
        where: { accountId_clientId: { accountId, clientId } },
        create: { accountId, clientId, role },
        update: { role },
      });
    }
    await this.audit.log({ action: 'account.role_set', accountId, clientId, detail: { role, by: actor ?? 'cli' } });
  }

  async findByEmail(email: string): Promise<Account | null> {
    return this.prisma.account.findUnique({ where: { email: normalizeEmail(email) } });
  }

  /** Alle Rollen eines Kontos als Objekt `{ slug: rolle }`. */
  async rolesOf(accountId: string): Promise<Record<string, Role>> {
    const rows = await this.prisma.accountRole.findMany({ where: { accountId } });
    return Object.fromEntries(rows.map((r) => [r.clientId, r.role as Role]));
  }
}
