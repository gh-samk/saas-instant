import { randomUUID } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { authenticator } from 'otplib';
import { PrismaClient } from '.prisma/control-client';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import {
  LoginFailedError,
  AccountLockedError,
} from '../common/errors/business-error';
import { CryptoService } from '../crypto/crypto.service';
import type { MailService } from '../mail/mail.service';
import type { PrismaService } from '../prisma/prisma.service';
import { truncateAuditLog } from '../test-support/gobd-cleanup';
import { buildConfig } from '../test-support/login-provisioning';
import { LoginFlowService } from './login-flow.service';
import { EmailLoginCodeService } from './email-login-code.service';
import { DeviceService } from './device.service';
import type { PasskeyService } from './passkey.service';
import { SessionService } from './session.service';
import { MAX_FAILED_ATTEMPTS, LockoutService } from './lockout.service';
import { TotpService } from './totp.service';
import { RecoveryCodeService } from './recovery-code.service';
import { AccessService } from './access.service';
import type { SessionUser } from './session.service';

/**
 * [K5] gegen eine ECHTE Postgres-Datenbank.
 *
 * Der Befund war eine ungebremste Ratestrecke auf `totp/bestaetigen`: gemessen
 * an der laufenden Anwendung gingen 100 Versuche durch (das globale IP-Limit),
 * danach stand `fehlversuche` auf 0, `gesperrtBis` auf NULL und im Audit-Log
 * lagen null neue Zeilen.
 *
 * Warum dieser Lauf NICHT gegen die In-Memory-Attrappe geht: die entscheidende
 * Frage ist, ob GLEICHZEITIGE Rateversuche jeder für sich zählen oder ob sich
 * ein Angreifer den Zähler durch Bündeln auf 1 festnageln kann. JavaScript ist
 * einfädig — dort kann dieses Rennen gar nicht entstehen. Genau dasselbe
 * Argument steht über `sperre.integration.spec.ts`; dort ist der Zähler selbst
 * geprüft, hier der Weg dorthin über die neue Strecke.
 *
 * Voraussetzung:
 *   docker compose --profile control up -d control-db
 *   DATABASE_URL=postgresql://…:5434/…_integration pnpm test:integration
 */

jest.setTimeout(60_000);

const SOURCE = { ip: '203.0.113.77', userAgent: 'Jest-Integration' };

const prisma = new PrismaClient() as unknown as PrismaService;
const config = buildConfig();
const crypto = new CryptoService(config);
const audit = new AuditService(prisma);
const totp = new TotpService(prisma, crypto, config);

const access = new AccessService(
  prisma,
  {} as unknown as PasskeyService,
  totp,
  new RecoveryCodeService(prisma),
  new EmailLoginCodeService(prisma),
  {
    sendLoginCode: async () => undefined,
    sendAddressChangeNote: async () => undefined,
  } as unknown as MailService,
  new DeviceService(prisma),
  new LoginFlowService(new JwtService({ secret: 'test' }), config),
  new SessionService(new JwtService({ secret: 'test' }), config, prisma),
  new LockoutService(prisma, audit),
  audit,
);

/** Legt ein frisches Konto ohne jeden Faktor an. */
async function newAccount(): Promise<SessionUser> {
  const identifier = `totpk5-${randomUUID().slice(0, 8)}`;
  return prisma.user.create({
    data: {
      name: 'Ratestrecke',
      username: identifier,
      email: `${identifier}@example.com`,
    },
    select: { id: true, name: true, username: true, email: true, role: true },
  });
}

async function stateOf(id: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id },
    select: {
      failedAttempts: true,
      lockedUntil: true,
      totpSecret: true,
      totpSecretPending: true,
      totpPendingValidUntil: true,
    },
  });
}

afterAll(async () => {
  // AuditLog ist append-only (GoBD-Trigger): nur TRUNCATE im Testpfad.
  await truncateAuditLog(prisma);
  await prisma.user.deleteMany({
    where: { username: { startsWith: 'totpk5-' } },
  });
  await (prisma as unknown as PrismaClient).$disconnect();
});

describe('[K5] Gebündeltes Raten auf totp/bestaetigen nagelt den Zähler nicht fest', () => {
  it('zählt GLEICHZEITIGE Fehlversuche einzeln und sperrt danach', async () => {
    const user = await newAccount();
    await access.totpSetup(user);
    expect((await stateOf(user.id)).failedAttempts).toBe(0);

    // Alle Rateversuche auf einmal — nicht nacheinander. Gegen eine Fassung,
    // die den Zähler in JavaScript aus einem vorher gelesenen Snapshot
    // fortschreibt, bliebe er hier auf 1 stehen.
    const results = await Promise.allSettled(
      Array.from({ length: MAX_FAILED_ATTEMPTS }, (_, number) =>
        access.totpConfirm(
          user,
          String(100000 + number).padStart(6, '0'),
          SOURCE,
        ),
      ),
    );

    // Kein einziger Versuch darf durchgehen: geraten wurde nichts Richtiges.
    expect(results.every((e) => e.status === 'rejected')).toBe(true);
    for (const result of results) {
      if (result.status !== 'rejected') continue;
      expect(
        result.reason instanceof LoginFailedError ||
          result.reason instanceof AccountLockedError,
      ).toBe(true);
    }

    const state = await stateOf(user.id);
    expect(state.failedAttempts).toBe(MAX_FAILED_ATTEMPTS);
    expect(state.lockedUntil).not.toBeNull();

    // Jeder Fehlschlag hinterlässt eine Zeile — der Befund war „0 neue Zeilen".
    const errorLines = await prisma.auditLog.count({
      where: {
        userId: user.id,
        action: AUDIT_ACTION.totpSetupError,
      },
    });
    expect(errorLines).toBe(MAX_FAILED_ATTEMPTS);

    // Und genau EIN Sperr-Eintrag, auch bei gebündelten Anfragen.
    const lockoutLines = await prisma.auditLog.count({
      where: { userId: user.id, action: AUDIT_ACTION.accountLocked },
    });
    expect(lockoutLines).toBe(1);
  });

  it('lässt das aktive Geheimnis nach gebündeltem Raten unverändert leer', async () => {
    const user = await newAccount();
    await access.totpSetup(user);

    await Promise.allSettled(
      Array.from({ length: 12 }, (_, number) =>
        access.totpConfirm(
          user,
          String(200000 + number).padStart(6, '0'),
          SOURCE,
        ),
      ),
    );

    // Der Kern des Befundes: ein Treffer hätte hier ein aktives `totpGeheimnis`
    // hinterlassen und damit einen gültigen zweiten Faktor für ALLE Routen.
    expect((await stateOf(user.id)).totpSecret).toBeNull();
  });
});

describe('[K5] Eine zweite Einrichtung lässt die erste leerlaufen', () => {
  it('aktiviert über den überholten Vorgang nichts mehr', async () => {
    const user = await newAccount();
    const first = await access.totpSetup(user);
    // Zweiter Dialog: überschreibt das vorläufige Geheimnis der ersten.
    const second = await access.totpSetup(user);
    expect(second.secretBase32).not.toBe(first.secretBase32);

    // Der Code aus dem ERSTEN QR-Code passt jetzt auf nichts mehr.
    await expect(
      access.totpConfirm(
        user,
        totpCodeTo(first.secretBase32),
        SOURCE,
      ),
    ).rejects.toBeInstanceOf(LoginFailedError);

    // Der zweite dagegen schon — und er aktiviert SEIN Geheimnis.
    await access.totpConfirm(
      user,
      totpCodeTo(second.secretBase32),
      SOURCE,
    );
    const state = await stateOf(user.id);
    expect(state.totpSecretPending).toBeNull();
    expect(state.totpPendingValidUntil).toBeNull();
    expect(crypto.decrypt(state.totpSecret!)).toBe(
      second.secretBase32,
    );
  });
});

/** Aktueller gültiger Code zu einem Geheimnis. */
function totpCodeTo(secret: string): string {
  return authenticator.generate(secret);
}
