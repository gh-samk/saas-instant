import type { Request } from 'express';
import { isIP } from 'node:net';
import { KEY_HEADER, keyMatches } from '../public/key';

/**
 * Wogegen zählt das Rate-Limit? ([W1])
 *
 * DAS PROBLEM: `trust proxy` gilt für den ganzen Prozess, aber die beiden Wege
 * in diese Anwendung haben VERSCHIEDEN LANGE Ketten:
 *
 *   Verwaltung:      Browser -> Traefik -> control-web (nginx) -> hier   (2)
 *   Öffentliche      Browser -> Traefik -> webseite-nginx ->
 *   Anfrage:                    Traefik -> control-web (nginx) -> hier   (4)
 *
 * Mit `CONTROL_TRUST_PROXY=2` liest Express für den zweiten Weg die Adresse
 * eines PROXYS statt die des Clients — und dann teilen sich ALLE Besucher der
 * Webseite ein einziges Kontingent. Gemessen: acht verschiedene Clients, ab dem
 * sechsten `429`. Ein einzelner Rechner legt damit den Anfragekanal für alle
 * lahm.
 *
 * DIE LÖSUNG: ein eigener Zähler-Schlüssel für die öffentlichen Wege
 * (`ANFRAGE_PFADE`), der so viele Einträge von rechts überspringt, wie diese
 * Kette lang ist (`CONTROL_INQUIRY_TRUST_PROXY`).
 *
 * WARUM MAN DEM HEADER HIER GLAUBEN DARF — und sonst nicht:
 * Nur wer den SCHLÜSSEL mitschickt, ist durch das nginx der Webseite gekommen;
 * dessen `X-Forwarded-For` ist dann so vertrauenswürdig wie der Proxy selbst.
 *
 * SEIT 15.09.2026 AUCH FÜR DIE HERKUNFT IM NACHWEIS (`herkunftAusAnfrage`).
 * Vorher stand hier „niemals für das Audit-Log" – mit der Folge, dass bei
 * Anfrage, AGB-Zustimmung und Newsletter-Eintragung ausnahmslos die Adresse
 * eines Proxys gespeichert wurde (gemessen: nur private Adressen). Der
 * Nachweis war damit wertlos. Der gelesene Eintrag stammt aber nicht vom
 * Absender, sondern von UNSEREM ersten Traefik: Es ist die Gegenstelle der
 * TCP-Verbindung. Ein Absender kann nur Einträge LINKS davon hinzufügen, und
 * gezählt wird von rechts. Ohne gültigen Schlüssel oder bei zu kurzer Kette
 * gilt weiterhin `req.ip`.
 *
 * NACHTRAG, GEMESSEN AM 15.09.2026: Die Kettenrechnung griff in Produktion NIE.
 * Seit Webseite und Verwaltung getrennte Deployments sind (02.09.2026),
 * erreicht das Webseiten-nginx die Verwaltung über ihre öffentliche Adresse,
 * und der zweite Traefik VERWIRFT dessen X-Forwarded-For (fremder Absender).
 * Angekommen sind zwei interne Einträge statt vier – also Rückfall auf
 * `req.ip`, für ALLE Besucher dieselbe Proxy-Adresse. Deshalb schreibt das
 * nginx die Adresse jetzt in eine eigene Kopfzeile (`ABSENDER_HEADER`), die
 * Traefik durchreicht. Die Kettenrechnung bleibt als Rückfall für einen
 * Aufbau ohne zweiten Traefik (Bundle im selben Netz).
 *
 * DER SCHLÜSSEL WIRD HIER SELBST GEPRÜFT, und das ist keine Doppelung: Der
 * `ThrottlerGuard` ist ein `APP_GUARD` und läuft VOR dem
 * `AnfrageSchluesselGuard` am Controller. „Wer die Route erreicht, hat den
 * Schlüssel bewiesen" stimmt an dieser Stelle also noch nicht. Ohne eigene
 * Prüfung genügte ein erfundener `X-Forwarded-For` je Anfrage, um sich
 * unbegrenzt frische Kontingente zu holen — und jede danach abgewiesene
 * Anfrage schreibt eine Zeile ins Audit-Log, das keinen Löschlauf hat. Ein
 * Unbeteiligter hätte die Datenbank volllaufen lassen können.
 *
 * Ohne gesetzte Variable ändert sich nichts: dann gilt `req.ip` wie bisher.
 */
/**
 * ===========================================================================
 * GENAU DIE PFADE, DIE ÜBER DAS NGINX DER WEBSEITE HEREINKOMMEN
 * ===========================================================================
 *
 * EINE LISTE UND KEINE KONSTANTE — das war [K2]. Als mit Etappe 5 der zweite
 * öffentliche Schreibweg dazukam (`/api/einwilligung/anmeldung`), fiel er auf
 * `req.ip` zurück; bei `CONTROL_TRUST_PROXY=2` teilten sich damit alle
 * Besucher der Webseite weltweit ein Kontingent von fünf Anfragen je Minute.
 *
 * DIE LISTE WAR DANACH ZU BREIT — das war [W7]. `/api/einwilligung` als
 * PRÄFIX deckte auch Bestätigung, Abmeldung und die Sperrroute ab. Die kommen
 * NICHT über das Webseiten-nginx: Ein Bestätigungslink wird direkt aus dem
 * Postfach angeklickt, die Ein-Klick-Abmeldung ruft der Mailclient selbst auf,
 * und die Sperrroute liegt hinter einer Sitzung. Ihre echte Kette ist kürzer
 * als `CONTROL_INQUIRY_TRUST_PROXY`, und dann greift `ausWeiterleitung` in die
 * Einträge hinein, die der CLIENT selbst geschrieben hat. Gemessen:
 *
 * ```
 * A) echte Kette (2 Einträge), ein Client         -> 10 von 30 mit 429
 * B) zwei vorangestellte Fantasiewerte je Anfrage ->  0 von 30 mit 429
 * C) Gegenprobe echter Anfrageweg (6 Einträge)    -> 25 von 30 mit 429
 * ```
 *
 * Mit zwei erfundenen Einträgen bekam jede Anfrage ein frisches Kontingent —
 * das Rate-Limit war auf diesen Routen wirkungslos.
 *
 * DESHALB STEHEN HIER VOLLSTÄNDIGE ROUTENPFADE und keine Modulpräfixe. Die
 * Begründung „die einzige Route, die einen SCHLÜSSEL verlangt" gilt genau für
 * diese Einträge und für keinen anderen.
 *
 * WARUM KEIN DEKORATOR JE ROUTE, wie er naheläge: `getTracker` des Throttlers
 * bekommt nur das `Request`-Objekt, keinen `ExecutionContext`. Ohne den lassen
 * sich Routen-Metadaten nicht lesen. Die Liste ist damit die einzige Stelle,
 * an der die Zuordnung stehen kann — und `anfrage-tracker.spec.ts` zählt sie
 * in BEIDE Richtungen ab: jede Route eines Schlüssel-Controllers muss gedeckt
 * sein, und keine andere darf es sein.
 */
export const INQUIRY_PATHS = [
  // Der Anfrageweg der Webseite (Demo/Pilot). Ganzes Modul, weil jede Route
  // darin am `AnfrageSchluesselGuard` hängt.
  '/api/public',
  // NUR die Eintragung. Bestätigung, Abmeldung und Sperre kommen nicht über
  // das Webseiten-nginx — siehe oben.
  '/api/consent/subscription',
] as const;

/** Kommt die Anfrage über einen der öffentlichen Wege herein? */
export function isInquiryPath(path: string): boolean {
  // Nur der Pfadanteil zählt; ein Fragezeichen oder ein weiteres Segment
  // dahinter ändert die Zuordnung nicht.
  const withoutQuery = path.split('?')[0] ?? '';
  return INQUIRY_PATHS.some(
    (entry) => withoutQuery === entry || withoutQuery.startsWith(`${entry}/`),
  );
}

/** Der Zähler-Schlüssel für eine Anfrage. */
export function trackerFor(
  req: Request,
  inquiryHops: number | null,
  expectedKey: string | undefined,
): string {
  const path = req.originalUrl ?? req.url ?? '';
  if (!isInquiryPath(path)) {
    return req.ip ?? 'unbekannt';
  }
  return inquiryClientIp(req, inquiryHops, expectedKey) ?? req.ip ?? 'unbekannt';
}

/**
 * Die Adresse des Formularbesuchers auf den öffentlichen Wegen – oder `null`.
 *
 * `null`, wenn die Kettenlänge nicht eingerichtet ist, der Schlüssel fehlt
 * oder falsch ist (dann gilt, was Express ermittelt, nicht was der Aufrufer
 * sich ausdenken darf) oder die Kette kürzer ist als erwartet.
 *
 * EINE Funktion für Zählung UND Herkunft: Zwei Fassungen derselben Rechnung
 * liefen auseinander, und dann zählte das Rate-Limit gegen eine andere
 * Adresse, als der Nachweis nennt.
 */
export function inquiryClientIp(
  req: Request,
  inquiryHops: number | null,
  expectedKey: string | undefined,
): string | null {
  if (!keyIncluded(req, expectedKey)) return null;
  // 1. Die eigene Kopfzeile des Webseiten-nginx. Das nginx ÜBERSCHREIBT sie
  //    immer; ein Besucher kann sie nur auf dem direkten Weg setzen – und dort
  //    fehlt ihm der Schlüssel. Kein gültiges IP-Format -> nicht verwenden.
  const reported = senderFromHeaderLine(req);
  if (reported !== null) return reported;
  // 2. Rückfall: die Weiterleitungskette.
  if (inquiryHops === null) return null;
  return fromForwarding(req, inquiryHops);
}

/**
 * Die Kopfzeile, in die das nginx der Webseite die Adresse des
 * Formularbesuchers schreibt (`apps/webseite/nginx.conf.template`).
 */
export const SENDER_HEADER = 'x-sender-ip';

function senderFromHeaderLine(req: Request): string | null {
  const raw = req.headers[SENDER_HEADER];
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value !== '' && isIP(value) !== 0 ? value : null;
}

/** Zeitkonstanter Vergleich, dieselbe Funktion wie im Guard. */
function keyIncluded(
  req: Request,
  expected: string | undefined,
): boolean {
  const clean = (expected ?? '').trim();
  if (clean === '') return false;
  const raw = req.headers[KEY_HEADER];
  const value = Array.isArray(raw) ? undefined : raw;
  return keyMatches(value, clean);
}

/**
 * Liest den `anfrageHops`-ten Eintrag VON RECHTS aus `X-Forwarded-For`.
 *
 * Rechts steht, was der letzte Proxy angehängt hat; links, was der Client
 * behauptet. Deshalb wird von rechts gezählt: Nur so viele Einträge, wie es
 * vertrauenswürdige Zwischenstationen gibt, werden übersprungen — genau die
 * Rechnung, die Express für `req.ip` anstellt.
 */
export function fromForwarding(
  req: Request,
  hops: number,
): string | null {
  const raw = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(raw) ? raw.join(',') : (raw ?? ''))
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (chain.length === 0) return null;

  const index = chain.length - hops;
  // Ist die Kette kürzer als erwartet, wird NICHT auf den linkesten Eintrag
  // ausgewichen: Der ist frei erfunden, und ein Angreifer bekäme mit jedem
  // neuen Fantasiewert ein frisches Kontingent.
  if (index < 0 || index >= chain.length) return null;
  return chain[index];
}

/** Liest die Kettenlänge aus der Umgebung; `null` = nicht eingerichtet. */
export function inquiryHopsFrom(value: string | undefined): number | null {
  const raw = (value ?? '').trim();
  if (raw === '') return null;
  const number = Number(raw);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(
      `CONTROL_INQUIRY_TRUST_PROXY muss eine ganze Zahl >= 1 sein, war "${raw}". ` +
        'Leer lassen heißt: es gilt dieselbe Kette wie für die Verwaltung.',
    );
  }
  return number;
}
