import 'reflect-metadata';
import { userInfo } from 'os';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { EmergencyService } from '../auth/emergency.service';
import { LockoutService } from '../auth/lockout.service';
import { FirstAccountService } from '../users/first-account.service';

/**
 * Emergency commands (Notfallkommandos) für die Verwaltung, im Container ausführbar:
 *
 *   node dist/cli/emergency.js first-account <email> <name>
 *   node dist/cli/emergency.js enrollment    <kennung>
 *   node dist/cli/emergency.js password      <kennung>
 *   node dist/cli/emergency.js unlock        <kennung>
 *
 * `kennung` ist der Benutzername ODER die E-Mail-Adresse des Kontos.
 *
 * `enrollment` und `password` erzeugen einen einmaligen, 15 Minuten
 * gültigen Link. Weder ein Passkey noch ein Passwort lässt sich im Container
 * erzeugen: der Passkey entsteht nur im Browser am Gerät des Benutzers, und
 * ein Passwort darf NIEMALS über das Terminal, stdout oder Container-Logs
 * laufen. Der Server öffnet deshalb nur den Weg dorthin.
 *
 * Beide schreiben ins Audit-Log mit dem Akteur `cli:<OS-Benutzer>` — beim
 * Erzeugen und beim Einlösen. Das einzige Geheimnis auf stdout ist der Link,
 * und der lebt 15 Minuten.
 */

/** Formatiert eine Uhrzeit für die Ausgabe im Terminal (lokale Zeitzone). */
function asTime(timestamp: Date): string {
  return timestamp.toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

const COMMANDS = ['first-account', 'enrollment', 'password', 'unlock'] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

function help(): void {
  process.stdout.write(
    [
      'Notfallkommandos der Verwaltung.',
      '<kennung> ist Benutzername oder E-Mail-Adresse.',
      '',
      '  emergency first-account <email> <name>  ERSTES Konto einer leeren Verwaltung anlegen',
      '                                          (nur solange es kein einziges Konto gibt)',
      '  emergency enrollment    <kennung>       Link zum Anlegen eines Passkeys (15 Minuten gültig)',
      '  emergency password      <kennung>       Link zum Setzen eines neuen Passworts (15 Minuten gültig)',
      '  emergency unlock        <kennung>       Kontosperre und Fehlversuche sofort zurücksetzen',
      '',
      '  first-account, enrollment und password markieren das Konto zugleich als Notzugang',
      '  (emergency=true): im Modus portal (AUTH_MODE=portal) darf sich nur ein solches Konto lokal anmelden.',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<number> {
  const [command, identifier] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    help();
    return command ? 0 : 1;
  }
  if (!isCommand(command)) {
    process.stderr.write(`Unbekanntes Kommando "${command}".\n\n`);
    help();
    return 1;
  }
  if (!identifier) {
    process.stderr.write(
      command === 'first-account'
        ? 'Dem Kommando "first-account" fehlt die E-Mail-Adresse.\n\n'
        : `Dem Kommando "${command}" fehlt die Kennung des Kontos.\n\n`,
    );
    help();
    return 1;
  }
  // Beim Erstkonto ist alles nach der Adresse der Name — Menschen haben
  // Leerzeichen im Namen, und Anführungszeichen vergisst man im Terminal.
  const name = process.argv.slice(4).join(' ').trim();
  if (command === 'first-account' && name === '') {
    process.stderr.write(
      'Dem Kommando "first-account" fehlt der Name.\n' +
        'Beispiel: emergency first-account sam@example.com Samuel Kuemmel\n\n',
    );
    return 1;
  }

  const actor = `cli:${userInfo().username}`;
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    if (command === 'first-account') {
      const first = app.get(FirstAccountService);
      const link = await first.create(identifier, name, actor);
      // Im Modus `portal` ist das die einzige lokale Anmeldung.
      await app.get(EmergencyService).markEmergencyAccount(link.username);
      process.stdout.write(
        [
          '',
          `Erstes Konto angelegt: ${link.username}`,
          '',
          'Registrierlink erzeugt. Im Browser öffnen und dort den Passkey anlegen.',
          'Der Passkey ersetzt Passwort und zweiten Faktor zugleich — dieses',
          'Konto kommt damit auch ohne funktionierenden Mailversand hinein.',
          `Gültig bis ${asTime(link.expiresAt)} Uhr, danach verfällt er.`,
          'Er lässt sich genau einmal einlösen.',
          '',
          link.url,
          '',
        ].join('\n'),
      );
      return 0;
    }

    if (command === 'unlock') {
      const lockout = app.get(LockoutService);
      const state = await lockout.unlock(identifier, actor);
      process.stdout.write(
        state.wasLocked
          ? `\nSperre für "${identifier}" aufgehoben (${state.failedAttemptsBefore} Fehlversuche zurückgesetzt).\n\n`
          : `\n"${identifier}" war nicht gesperrt. Fehlversuche (${state.failedAttemptsBefore}) wurden trotzdem zurückgesetzt.\n\n`,
      );
      return 0;
    }

    const emergency = app.get(EmergencyService);
    const kind = command === 'password' ? 'password' : 'passkey';
    const link = await emergency.generateLink(identifier, kind, actor);
    // Notzugang: im Modus `portal` darf sich dieses Konto lokal anmelden.
    await emergency.markEmergencyAccount(identifier);

    const introduction =
      kind === 'password'
        ? [
            'Link zum Setzen eines neuen Passworts erzeugt.',
            'Im Browser öffnen und das Passwort DORT eingeben — dieses Kommando',
            'nimmt bewusst kein Passwort entgegen und gibt keines aus.',
          ]
        : [
            'Registrierlink erzeugt. Im Browser öffnen und dort den Passkey anlegen.',
          ];

    process.stdout.write(
      [
        '',
        ...introduction,
        `Gültig bis ${asTime(link.expiresAt)} Uhr, danach verfällt er.`,
        'Er lässt sich genau einmal einlösen.',
        '',
        link.url,
        '',
      ].join('\n'),
    );
    return 0;
  } finally {
    await app.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\nFehlgeschlagen: ${message}\n\n`);
    process.exitCode = 1;
  });
