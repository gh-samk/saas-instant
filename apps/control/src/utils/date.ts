import { dateFromString } from '@saas-instant/shared';
import { t } from '../i18n';

/**
 * Datumsanzeige der Verwaltung: durchgehend `dd.mm.yyyy`, niemals ISO.
 *
 * Eingabe ist entweder ein reiner Kalendertag (`YYYY-MM-DD`) oder ein
 * technischer Zeitstempel (`2026-08-29T16:10:02.123Z`), wie ihn die
 * Geräteliste liefert. Zeitstempel werden auf den **lokalen** Kalendertag
 * reduziert — die Uhrzeit wird nirgends angezeigt (Regel 1 der Projektkonventionen).
 *
 * Der Kalendertag wird vor der Ausgabe mit `datumAusString` aus
 * `@saas-instant/shared` geprüft; ein unmögliches Datum fällt damit auf, statt
 * still als Zeichensalat in der Tabelle zu landen.
 */
export function formatDate(value: string): string {
  const calendarDay = dateFromString(calendarDayFrom(value));
  const [year, month, tag] = calendarDay.split('-');
  return `${tag}.${month}.${year}`;
}

/** Reduziert einen Zeitstempel auf den lokalen Kalendertag `YYYY-MM-DD`. */
function calendarDayFrom(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error(t('common.date.error', { value: value }));
  }
  const year = timestamp.getFullYear();
  const month = String(timestamp.getMonth() + 1).padStart(2, '0');
  const tag = String(timestamp.getDate()).padStart(2, '0');
  return `${year}-${month}-${tag}`;
}

/**
 * Wandelt Tagesdaten `YYYY-MM-DD`, die INNERHALB eines Servertexts stehen, in
 * `dd.mm.yyyy` um.
 *
 * WARUM ES DAS GIBT: Vier Aufgabenquellen der Etappe 3 setzen den Kalendertag
 * direkt in ihre Begründung ein („Der Abgleich konnte am 2026-08-31 keine
 * passende Anwendung finden."). Das Datumsformat der Anwendung ist aber
 * durchgehend `dd.mm.yyyy`, und ein ISO-Datum mitten im Fließtext ist genau
 * der Bruch, den Etappe 1 an keiner Stelle zulässt.
 *
 * Die saubere Stelle wäre das Backend; solange es die Texte so liefert, ist
 * die Anzeigeschicht der einzige Ort, an dem die Regel noch greifen kann.
 * Unlesbare Treffer (etwa „2026-13-40") bleiben unangetastet — es wird nichts
 * geraten.
 */
export function dateInText(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2}/g, (match) => {
    try {
      return formatDate(match);
    } catch {
      return match;
    }
  });
}
