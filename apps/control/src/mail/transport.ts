import type { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

/**
 * DER SMTP-UNTERBAU — und ausdrücklich NICHT der Versandweg.
 *
 * R3 verlangt getrennte Codepfade für Transaktions- und Werbemails. Getrennt
 * sein müssen die ENTSCHEIDUNGEN: wer etwas bekommt, unter welcher
 * Einwilligung, mit welchen Kopfzeilen, mit welcher Fußzeile. Was hier steht,
 * entscheidet nichts davon — es baut eine Verbindung auf.
 *
 * Diese eine Stelle gemeinsam zu benutzen ist nicht die Bequemlichkeit, gegen
 * die R3 sich richtet, sondern das Gegenteil: Die Verschlüsselungspflicht aus
 * [W4] steht dann für beide Kanäle nur EINMAL im Code. Zwei Abschriften davon
 * wären zwei Stellen, an denen jemand `requireTLS` vergessen kann, und die
 * zweite fällt niemandem auf.
 */
export interface TransportEnvironment {
  /** Ist überhaupt ein Postausgang eingerichtet? */
  configured: boolean;
  /** Bricht der Versand ab, wenn der Gegenüber kein STARTTLS anbietet? */
  tlsEnforced: boolean;
}

/** Liest die SMTP-Umgebung, ohne eine Verbindung aufzubauen. */
export function transportEnvironment(config: ConfigService): TransportEnvironment {
  return {
    configured: Boolean(config.get<string>('SMTP_HOST')),
    tlsEnforced: config.get<string>('SMTP_TLS_ERZWINGEN', '1') !== '0',
  };
}

/**
 * Baut den Transport pro Versand — eine geänderte Umgebung wirkt sofort.
 *
 * Ohne `SMTP_HOST` wird `jsonTransport` benutzt: Die Mail geht nirgendwohin
 * und landet nur in der Server-Konsole. Das ist der Entwicklungsmodus, den
 * `apps/api` und `apps/control` seit jeher benutzen.
 *
 * `secure` richtet sich nach dem Port: 465 spricht von der ersten Oktett an
 * TLS (SMTPS), 587 und 25 beginnen im Klartext und heben per STARTTLS ab.
 * `requireTLS` lässt den Versand abbrechen, wenn der Gegenüber kein STARTTLS
 * anbietet — sonst genügte es, STARTTLS aus der EHLO-Antwort zu streichen,
 * und nodemailer verschickte alles im Klartext ([W4]).
 */
export function buildTransport(config: ConfigService): nodemailer.Transporter {
  const host = config.get<string>('SMTP_HOST');
  if (!host) {
    return nodemailer.createTransport({ jsonTransport: true });
  }
  const port = Number(config.get<string>('SMTP_PORT', '587'));
  const user = config.get<string>('SMTP_USER');
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: transportEnvironment(config).tlsEnforced,
    auth: user
      ? { user: user, pass: config.get<string>('SMTP_PASS') }
      : undefined,
  });
}
