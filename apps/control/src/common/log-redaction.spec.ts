import { Writable } from 'stream';
import pinoHttp from 'pino-http';
import { buildLogConfig, LOG_REDACT } from './log-config';
import { MASK } from './log-masking';
import { KEY_HEADER } from '../public/key';

/**
 * WAS OHNE DIESEN TEST PASSIERT IST (Produktionslog, 07.09.2026):
 *
 * Die `redact`-Liste deckte Cookie, CSRF-Header und `set-cookie` ab — aber
 * nicht `x-anfrage-schluessel`. Bei JEDEM `POST /api/oeffentlich/anfrage`
 * schrieb der Request-Logger daher den vollständigen Header-Satz samt dem
 * Geheimnis, mit dem sich das nginx der Webseite bei der Verwaltung ausweist.
 * Wer es hat, kann beliebige Anfragen einliefern. Es liegt bewusst ausserhalb
 * des Repositorys — im Container-Log lag es trotzdem, und Logs sind über die
 * Coolify-Oberfläche einsehbar.
 *
 * Der Test schickt eine echte Anfrage durch einen ECHTEN pino-Logger mit der
 * ECHTEN Konfiguration und liest mit, was herauskommt. Er prüft nicht, ob eine
 * Liste bestimmte Zeichenketten enthält — er prüft, dass das Geheimnis nicht
 * in der Logzeile steht. Eine Redaktion, die aus irgendeinem Grund nicht
 * greift, fällt damit hier auf und nicht wieder erst im Betrieb.
 */

/** Erkennbare Platzhalter — taucht einer davon in der Zeile auf, ist es ein Leck. */
const NGINX_KEY = 'GEHEIM-nginx-ausweis-nicht-ins-log';
const BACKUP_KEY = 'GEHEIM-sicherungswerkzeug';
const SESSION_COOKIE = 'GEHEIM-sitzung';
const CSRF = 'GEHEIM-csrf';
const BEARER = 'GEHEIM-bearer';
const LOGOUT_TOKEN = 'GEHEIM-abmeldetoken';

function logLineFor(inquiry: Record<string, unknown>): string {
  const before = process.env['NODE_ENV'];
  // In der Produktivkonfiguration ist `transport` nicht gesetzt — nur dann
  // lässt sich ein eigener Strom mitlesen. Genau diese Form läuft im Betrieb.
  process.env['NODE_ENV'] = 'production';
  try {
    let output = '';
    const stream = new Writable({
      write(piece, _encoding, done) {
        output += String(piece);
        done();
      },
    });
    const logger = pinoHttp(buildLogConfig() as never, stream);
    logger.logger.info({ req: inquiry }, 'anfrage');
    return output;
  } finally {
    process.env['NODE_ENV'] = before;
  }
}

const PUBLIC_INQUIRY = {
  method: 'POST',
  url: '/api/public/inquiry',
  headers: {
    [KEY_HEADER]: NGINX_KEY,
    'x-backup-key': BACKUP_KEY,
    cookie: `session=${SESSION_COOKIE}`,
    'x-csrf-token': CSRF,
    authorization: `Bearer ${BEARER}`,
    'user-agent': 'Mozilla/5.0',
    'content-type': 'application/json',
  },
};

describe('Redaktion des Anwendungslogs', () => {
  it('schreibt den Anfrage-Schlüssel des nginx NICHT ins Log', () => {
    const line = logLineFor(PUBLIC_INQUIRY);

    expect(line).not.toContain(NGINX_KEY);
    // Der Header selbst darf dastehen — nur sein Wert nicht.
    expect(line).toContain(KEY_HEADER);
  });

  it('schreibt kein anderes bekanntes Geheimnis ins Log', () => {
    const line = logLineFor(PUBLIC_INQUIRY);

    expect(line).not.toContain(BACKUP_KEY);
    expect(line).not.toContain(SESSION_COOKIE);
    expect(line).not.toContain(CSRF);
    expect(line).not.toContain(BEARER);
  });

  it('lässt das Log brauchbar — harmlose Felder bleiben stehen', () => {
    const line = logLineFor(PUBLIC_INQUIRY);

    // Ohne diese Zusicherung wäre „alles wegwerfen" eine bestandene Prüfung.
    expect(line).toContain('Mozilla/5.0');
    expect(line).toContain('/api/public/inquiry');
    expect(line).toContain('POST');
  });

  it('schreibt den Abmelde-Token aus dem Pfad NICHT ins Log', () => {
    const line = logLineFor({
      method: 'POST',
      url: `/api/consent/unsubscribe/${LOGOUT_TOKEN}`,
      headers: { 'user-agent': 'Mozilla/5.0' },
    });

    expect(line).not.toContain(LOGOUT_TOKEN);
    expect(line).toContain(MASK);
  });

  it('schreibt den Bestätigungs-Token aus dem Pfad NICHT ins Log', () => {
    const line = logLineFor({
      method: 'GET',
      url: `/api/consent/confirmation/${LOGOUT_TOKEN}`,
      headers: { 'user-agent': 'Mozilla/5.0' },
    });

    expect(line).not.toContain(LOGOUT_TOKEN);
    expect(line).toContain(MASK);
  });

  it('schreibt den Token aus dem Referer NICHT ins Log', () => {
    const line = logLineFor({
      method: 'POST',
      url: '/api/auth/emergency/check',
      headers: {
        referer: `https://host.example/emergency-enrollment?token=${LOGOUT_TOKEN}`,
      },
    });

    expect(line).not.toContain(LOGOUT_TOKEN);
    expect(line).toContain('emergency-enrollment');
  });

  /**
   * Die Klammer zur Quelle: Wird der Header im Guard umbenannt, ohne die
   * Redaktion nachzuziehen, schlägt dieser Test fehl — nicht erst das
   * Produktionslog.
   */
  it('führt den Anfrage-Schlüssel unter genau dem Namen, den der Guard prüft', () => {
    expect(LOG_REDACT).toContain(`req.headers["${KEY_HEADER}"]`);
  });
});
