import 'reflect-metadata';
import * as argon2 from 'argon2';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { CryptoService } from '../src/crypto/crypto.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { normalizeCode } from '../src/auth/recovery-code.service';

/**
 * Testzugang für die Entwicklung.
 *
 * Legt genau einen Benutzer mit BEKANNTEM Passwort, BEKANNTEM TOTP-Geheimnis,
 * eingerichtetem E-Mail-Anmeldecode und acht BEKANNTEN Wiederherstellungscodes
 * an, damit sich alle Anmeldewege ohne Handarbeit durchspielen lassen.
 *
 * Dieses Skript darf niemals gegen eine Produktionsdatenbank laufen: bei
 * `NODE_ENV=production` bricht es ab, bevor es irgendetwas anfasst. Zusätzlich
 * verlangt es eine DATABASE_URL, in deren Namen `control` vorkommt — das ist
 * die Datenbank der Verwaltung (harte Regel R1).
 *
 * Ausführen:  pnpm --filter @saas-instant/control seed
 */

/** Zugangsdaten des Testkontos. Bewusst öffentlich — nur für die Entwicklung. */
const TEST_USERNAME = 'test';
const TEST_EMAIL = 'test@example.com';
const TEST_NAME = 'Testbetreiberin';
const TEST_PASSWORD = 'entwicklung-passwort';
/** Base32, 32 Zeichen — direkt in eine Authenticator-App eintragbar. */
const TEST_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
/** Acht feste Codes im Format des RecoveryCodeService (xxxx-xxxx). */
const TEST_CODES = [
  'aaaa-2222',
  'bbbb-3333',
  'cccc-4444',
  'dddd-5555',
  'eeee-6666',
  'ffff-7777',
  'gggg-8888',
  'hhhh-9999',
];

function abortIfProduction(): void {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'Der Seed legt ein Konto mit bekanntem Passwort an und ist deshalb ' +
        'ausschließlich für die Entwicklung gedacht. NODE_ENV=production — ' +
        'Abbruch, es wurde nichts geschrieben.',
    );
  }
  // Zweite Schranke: ein ausdrücklicher Schalter, den niemand versehentlich
  // gesetzt hat. Die frühere Prüfung („control" muss in der DATABASE_URL
  // stehen) war wirkungslos, weil die Produktionsdatenbank `control`
  // heißt — sie hätte den Seed dort NICHT aufgehalten.
  if (process.env['CONTROL_SEED_ALLOWED'] !== 'ja') {
    throw new Error(
      'Der Seed legt ein Konto mit bekanntem Passwort und bekanntem ' +
        'TOTP-Geheimnis an. Er läuft nur mit CONTROL_SEED_ALLOWED=ja. ' +
        'Abbruch, es wurde nichts geschrieben.',
    );
  }
}

async function main(): Promise<void> {
  abortIfProduction();

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const prisma = app.get(PrismaService);
    const crypto = app.get(CryptoService);

    const passwordHash = await argon2.hash(TEST_PASSWORD, {
      type: argon2.argon2id,
    });
    const totpSecret = crypto.encrypt(TEST_TOTP_SECRET);

    const user = await prisma.user.upsert({
      where: { username: TEST_USERNAME },
      update: {
        name: TEST_NAME,
        email: TEST_EMAIL,
        passwordHash,
        totpSecret,
        // Auch der dritte Faktor ist eingerichtet, damit sich WIRKLICH jeder
        // Anmeldeweg durchspielen lässt. Der Code geht an TEST_EMAIL — ohne
        // SMTP_HOST steht er in der Server-Konsole ([DEV-MAIL]).
        loginCodeEnabled: true,
        loginCodeEmail: null,
        failedAttempts: 0,
        lockedUntil: null,
        // Ein halb angefangener TOTP-Einrichtungsdialog aus einem früheren
        // Lauf gehört nicht in einen bekannten Ausgangszustand. Er verfiele
        // zwar von selbst (siehe TOTP_PENDING_VALID_MS), aber der Seed
        // soll sagen können, wie das Konto aussieht — nicht „so oder so".
        totpSecretPending: null,
        totpPendingValidUntil: null,
      },
      create: {
        name: TEST_NAME,
        username: TEST_USERNAME,
        email: TEST_EMAIL,
        passwordHash,
        totpSecret,
        loginCodeEnabled: true,
      },
    });

    const hashes = await Promise.all(
      TEST_CODES.map((code) =>
        argon2.hash(normalizeCode(code), { type: argon2.argon2id }),
      ),
    );
    await prisma.$transaction(async (tx) => {
      await tx.recoveryCode.deleteMany({
        where: { userId: user.id },
      });
      await tx.recoveryCode.createMany({
        data: hashes.map((codeHash) => ({ userId: user.id, codeHash })),
      });
    });

    process.stdout.write(
      [
        '',
        'Testzugang der Verwaltung angelegt (nur Entwicklung):',
        `  Benutzername:      ${TEST_USERNAME}`,
        `  E-Mail:            ${TEST_EMAIL}`,
        `  Passwort:          ${TEST_PASSWORD}`,
        `  TOTP-Geheimnis:    ${TEST_TOTP_SECRET}`,
        `  Anmeldecode geht an: ${TEST_EMAIL}`,
        '    (ohne SMTP_HOST erscheint er als [DEV-MAIL] in der Server-Konsole)',
        '  Wiederherstellungscodes:',
        ...TEST_CODES.map((code) => `    ${code}`),
        '',
        'Passkeys lassen sich nicht seeden — sie entstehen nur im Browser.',
        '',
      ].join('\n'),
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nSeed fehlgeschlagen: ${message}\n\n`);
  process.exitCode = 1;
});
