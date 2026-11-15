/**
 * Maskiert Geheimnisse in der protokollierten Anfrage-URL der Verwaltung.
 *
 * WARUM: Das Gegenstueck der Kunden-API (`apps/api/src/common/log-maskierung.ts`)
 * gibt es hier bisher nicht — die Verwaltung protokollierte `req.url` roh. Zwei
 * Wege tragen ihr Geheimnis im PFAD: der Bestaetigungslink des Double-Opt-in
 * (`/api/consent/confirmation/:token`) und der Abmeldelink jeder
 * werblichen Mail (`/api/consent/unsubscribe/:token`, siehe
 * `einwilligung.service.ts`). Beide Token sind laut
 * `einwilligung-oeffentlich.controller.ts` die EINZIGE Absicherung dieser
 * Routen — dort tritt „an die Stelle des CSRF-Tokens der 256-Bit-Token in der
 * Adresse". Wer sie aus dem Log liest, kann eine fremde Einwilligung
 * bestaetigen oder eine fremde Adresse abmelden.
 *
 * Die Maskierung ersetzt nur die WERTE. Pfad, Reihenfolge und alle uebrigen
 * Parameter bleiben erhalten, damit das Log fuer die Fehlersuche brauchbar
 * bleibt.
 *
 * Dritter Pfad seit der Prüfung vom 13.09.2026: der AUFNAHMELINK
 * (`/api/intake/:token`, gebaut in `aufnahme-versand.service.ts`). Er gilt
 * 14 Tage und ist der einzige Zugang zur Erfassung der Bankverbindung. Er
 * stand bis dahin im Klartext im Log.
 *
 * Das nginx-Zugriffslog erreicht diese Funktion NICHT. Dort maskiert
 * `apps/control/nginx.conf` (log_format `ohne_geheimnisse`) dieselben Pfade.
 * WER HIER EINEN PFAD ERGÄNZT, ERGÄNZT IHN AUCH DORT.
 */

/** Query-Parameter, deren Wert niemals im Log stehen darf. */
export const SECRET_PARAMETER = ['token', 'setup-token', 'code'] as const;

/** Platzhalter anstelle des echten Wertes. */
export const MASK = '<maskiert>';

/**
 * Pfade, bei denen der NAECHSTE Abschnitt das Geheimnis ist.
 *
 * Mit UND ohne `/api`: `setGlobalPrefix('api')` veraendert `req.url` nicht
 * rueckwirkend, aber die Routen sind auch ohne Prefix erreichbar, wenn ein
 * Proxy den Pfad umschreibt. Beide Formen zu fuehren kostet nichts.
 */
export const SECRET_PATHS = [
  '/api/consent/confirmation',
  '/api/consent/unsubscribe',
  '/consent/confirmation',
  '/consent/unsubscribe',
  '/api/intake',
  '/intake',
] as const;

function maskPath(path: string): string {
  for (const start of SECRET_PATHS) {
    if (!path.startsWith(`${start}/`)) continue;
    const rest = path.slice(start.length + 1);
    if (rest === '') continue;
    // Was hinter dem Token noch folgt, bleibt sichtbar — es sagt, was versucht
    // wurde, und ist selbst kein Geheimnis.
    const further = rest.indexOf('/');
    const tail = further === -1 ? '' : rest.slice(further);
    return `${start}/${MASK}${tail}`;
  }
  return path;
}

/**
 * Maskiert eine Referer-Angabe (absolute URL). Der Browser haengt bei
 * same-origin-Aufrufen die Adresse der Seite an, und auf /emergency-*
 * steht dort `?token=...`.
 */
export function maskReferer(referer: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)(.*)$/i.exec(referer);
  if (!m) return maskUrl(referer);
  const rest = (m[2] ?? '').split('#')[0] ?? '';
  return `${m[1]}${maskUrl(rest)}`;
}

export function maskUrl(url: string): string {
  const separator = url.indexOf('?');
  if (separator === -1) return maskPath(url);

  const path = maskPath(url.slice(0, separator));
  const query = url.slice(separator + 1);
  if (query === '') return `${path}?`;

  // Bewusst von Hand statt ueber URLSearchParams: dessen toString() kodiert die
  // Zeichenkette neu und veraendert damit auch unverdaechtige Parameter. Fuer
  // ein Log soll die Zeile so aussehen wie die echte Anfrage.
  const parts = query.split('&').map((paar) => {
    const same = paar.indexOf('=');
    if (same === -1) return paar;
    const name = paar.slice(0, same);
    const isSecret = (SECRET_PARAMETER as readonly string[]).includes(
      name.toLowerCase(),
    );
    return isSecret ? `${name}=${MASK}` : paar;
  });

  return `${path}?${parts.join('&')}`;
}
