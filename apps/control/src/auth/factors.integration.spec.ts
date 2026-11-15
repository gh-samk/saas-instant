import { randomUUID } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '.prisma/control-client';
import { AuditService } from '../audit/audit.service';
import { LastFactorError } from '../common/errors/business-error';
import { CryptoService } from '../crypto/crypto.service';
import type { MailService } from '../mail/mail.service';
import type { PrismaService } from '../prisma/prisma.service';
import { buildConfig } from '../test-support/login-provisioning';
import { LoginFlowService } from './login-flow.service';
import { EmailLoginCodeService } from './email-login-code.service';
import { DeviceService } from './device.service';
import type { PasskeyService } from './passkey.service';
import { SessionService } from './session.service';
import { LockoutService } from './lockout.service';
import { TotpService } from './totp.service';
import { RecoveryCodeService } from './recovery-code.service';
import { AccessService } from './access.service';
import type { SessionUser } from './session.service';

/**
 * AK35 gegen eine ECHTE Postgres-Datenbank: der letzte zweite Faktor lässt
 * sich nicht entfernen — auch nicht mit zwei gleichzeitigen Anfragen.
 *
 * DIESER LAUF FEHLTE UND DESHALB RUTSCHTE [K1] DURCH 172 GRÜNE TESTS. Für
 * Sperrzähler, Wiederherstellungscodes und Codeeinlösung gab es solche
 * `Promise.all`-Läufe längst; für das Entfernen von Faktoren nicht. Mit einer
 * In-Memory-Attrappe ist der Nachweis auch nicht zu führen: JavaScript ist
 * einfädig, dort kann das Rennen gar nicht entstehen.
 *
 * Voraussetzung:
 *   docker compose --profile control up -d control-db
 *   DATABASE_URL=postgresql://…:5434/saas_instant_control pnpm test:integration
 */

jest.setTimeout(60_000);

const SOURCE = { ip: '203.0.113.55', userAgent: 'Jest-Integration' };
/**
 * Der Nachweis wird seit [K4] vom `ZweitfaktorGuard` an der Route erbracht,
 * nicht mehr im Service. `faktorEntfernen` nimmt ihn deshalb nicht mehr
 * entgegen; `widerrufe` schon, weil dieselbe Route zwei Fälle bedient. Die
 * Testkonten haben kein Passwort, deshalb wird über eine FRISCHE Sitzung
 * ausgewiesen — derselbe Weg, den die Ersteinrichtung geht.
 */
const EVIDENCE = {};
const FRESH = new Date();
const prisma = new PrismaClient() as unknown as PrismaService;
const config = buildConfig();
const crypto = new CryptoService(config);
const audit = new AuditService(prisma);
const devices = new DeviceService(prisma);
const codesPerMail = new EmailLoginCodeService(prisma);
const mail = {
  sendLoginCode: async () => undefined,
  sendAddressChangeNote: async () => undefined,
} as unknown as MailService;
const passkey = {} as unknown as PasskeyService;

const access = new AccessService(
  prisma,
  passkey,
  new TotpService(prisma, crypto, config),
  new RecoveryCodeService(prisma),
  codesPerMail,
  mail,
  devices,
  new LoginFlowService(new JwtService({ secret: 'test' }), config),
  new SessionService(new JwtService({ secret: 'test' }), config, prisma),
  new LockoutService(prisma, audit),
  audit,
);

interface TestAccount {
  user: SessionUser;
  passkeyIds: string[];
}

/** Legt ein Konto mit den gewünschten Faktoren an. */
async function newAccount(factors: {
  totp?: boolean;
  emailCode?: boolean;
  passkeys?: number;
}): Promise<TestAccount> {
  const identifier = `faktor-${randomUUID().slice(0, 8)}`;
  const user = await prisma.user.create({
    data: {
      name: 'Faktorprüfung',
      username: identifier,
      email: `${identifier}@example.com`,
      totpSecret: factors.totp ? crypto.encrypt('JBSWY3DPEHPK3PXP') : null,
      loginCodeEnabled: factors.emailCode ?? false,
    },
    select: { id: true, name: true, username: true, email: true, role: true },
  });

  const passkeyIds: string[] = [];
  for (let number = 0; number < (factors.passkeys ?? 0); number += 1) {
    const entry = await prisma.passkeyCredential.create({
      data: {
        userId: user.id,
        credentialId: `${identifier}-cred-${number}`,
        publicKey: 'oeffentlich',
        label: `Passkey ${number}`,
      },
      select: { id: true },
    });
    passkeyIds.push(entry.id);
  }
  return { user, passkeyIds };
}

/** Wie viele Faktoren stehen jetzt noch am Konto? */
async function factorsCount(userId: string): Promise<number> {
  const overview = await access.factors(userId);
  return overview.countSetUp;
}

/** Führt zwei Entfernungen GLEICHZEITIG aus und zählt die Erfolge. */
async function concurrent(
  ...calls: (() => Promise<unknown>)[]
): Promise<{ successes: number; lastFactorError: number }> {
  const results = await Promise.allSettled(calls.map((on) => on()));
  return {
    successes: results.filter((e) => e.status === 'fulfilled').length,
    lastFactorError: results.filter(
      (e) =>
        e.status === 'rejected' && e.reason instanceof LastFactorError,
    ).length,
  };
}

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { actor: { startsWith: 'faktor-' } } });
  await prisma.user.deleteMany({
    where: { username: { startsWith: 'faktor-' } },
  });
  await (prisma as unknown as PrismaClient).$disconnect();
});

describe('[K1] Der letzte Faktor überlebt auch gleichzeitige Löschanfragen', () => {
  it('TOTP ∥ E-Mail-Code auf die letzten ZWEI Faktoren — genau einer kommt durch', async () => {
    // Die Messung des Prüfers: beide gingen durch, danach anzahlEingerichtet 0.
    const { user } = await newAccount({ totp: true, emailCode: true });
    expect(await factorsCount(user.id)).toBe(2);

    const state = await concurrent(
      () => access.factorRemove(user, 'totp', SOURCE),
      () => access.factorRemove(user, 'email-code', SOURCE),
    );

    expect(state.successes).toBe(1);
    expect(state.lastFactorError).toBe(1);
    expect(await factorsCount(user.id)).toBe(1);
  });

  it('KREUZKOMBINATION Passkey ∥ E-Mail-Code — in 5 von 6 Läufen war das die Lücke', async () => {
    // Der Passkey-Löschpfad liegt in einer anderen Methode und in einer
    // anderen Tabelle. Ohne den gemeinsamen Zeilen-Lock auf `Benutzer` sieht
    // keiner der beiden den anderen kommen.
    for (let run = 0; run < 6; run += 1) {
      const { user, passkeyIds } = await newAccount({
        emailCode: true,
        passkeys: 1,
      });

      const state = await concurrent(
        () =>
          access.revoke(
            user,
            `passkey:${passkeyIds[0]}`,
            EVIDENCE,
            SOURCE,
            FRESH,
          ),
        () => access.factorRemove(user, 'email-code', SOURCE),
      );

      expect(state.successes).toBe(1);
      expect(await factorsCount(user.id)).toBe(1);
    }
  });

  it('KREUZKOMBINATION Passkey ∥ TOTP', async () => {
    for (let run = 0; run < 4; run += 1) {
      const { user, passkeyIds } = await newAccount({
        totp: true,
        passkeys: 1,
      });

      const state = await concurrent(
        () => access.revoke(user, `passkey:${passkeyIds[0]}`, EVIDENCE, SOURCE, FRESH),
        () => access.factorRemove(user, 'totp', SOURCE),
      );

      expect(state.successes).toBe(1);
      expect(await factorsCount(user.id)).toBe(1);
    }
  });

  it('DREI gleichzeitige Anfragen auf drei Faktoren lassen genau zwei durch', async () => {
    // Mehrfach, damit der Lauf ein verlässlicher Melder ist und nicht bloss
    // zufällig eine günstige Reihenfolge erwischt.
    for (let run = 0; run < 4; run += 1) {
      const { user, passkeyIds } = await newAccount({
        totp: true,
        emailCode: true,
        passkeys: 1,
      });
      expect(await factorsCount(user.id)).toBe(3);

      const state = await concurrent(
        () => access.factorRemove(user, 'totp', SOURCE),
        () => access.factorRemove(user, 'email-code', SOURCE),
        () => access.revoke(user, `passkey:${passkeyIds[0]}`, EVIDENCE, SOURCE, FRESH),
      );

      expect(state.successes).toBe(2);
      expect(state.lastFactorError).toBe(1);
      expect(await factorsCount(user.id)).toBe(1);
    }
  });

  it('zwei gleichzeitige Löschungen von ZWEI Passkeys bei drei Faktoren sind zulässig', async () => {
    // Gegenprobe: die Regel darf nicht mehr verbieten als nötig.
    const { user, passkeyIds } = await newAccount({
      emailCode: true,
      passkeys: 2,
    });

    const state = await concurrent(
      () => access.revoke(user, `passkey:${passkeyIds[0]}`, EVIDENCE, SOURCE, FRESH),
      () => access.revoke(user, `passkey:${passkeyIds[1]}`, EVIDENCE, SOURCE, FRESH),
    );

    expect(state.successes).toBe(2);
    expect(await factorsCount(user.id)).toBe(1);
  });

  it('weist sequenziell weiterhin sauber ab', async () => {
    const { user } = await newAccount({ totp: true });

    await expect(
      access.factorRemove(user, 'totp', SOURCE),
    ).rejects.toBeInstanceOf(LastFactorError);
    expect(await factorsCount(user.id)).toBe(1);
  });

  it('löscht keinen fremden Passkey, auch wenn die ID stimmt', async () => {
    const foreign = await newAccount({ emailCode: true, passkeys: 1 });
    const own = await newAccount({ emailCode: true, passkeys: 1 });

    await expect(
      access.revoke(
        own.user,
        `passkey:${foreign.passkeyIds[0]}`,
        EVIDENCE,
        SOURCE,
        FRESH,
      ),
    ).rejects.toThrow();
    expect(
      await prisma.passkeyCredential.count({
        where: { userId: foreign.user.id },
      }),
    ).toBe(1);
  });
});
