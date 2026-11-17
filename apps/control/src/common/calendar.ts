import { dateFromString } from '@saas-instant/shared';

/**
 * Kalenderrechnung auf TAGESDATEN (Regel 1 der Projektkonventionen): Ein- und Ausgabe
 * sind durchgehend `YYYY-MM-DD`, niemals ein ISO-Zeitstempel.
 *
 * `@saas-instant/shared` kennt `datumPlusTage`, aber keine Monatsrechnung — und
 * genau die braucht die Verwaltung: Fristen in Monaten
 * sind nicht „+ 30 Tage" je Monat. Bewusst hier und nicht in
 * `shared`: `apps/api` hat keine Monatsfrist, und ein gemeinsames Paket wächst
 * sonst um Dinge, die nur eine Anwendung braucht.
 */

function twoDigit(number: number): string {
  return String(number).padStart(2, '0');
}

/**
 * Addiert Kalendermonate zu einem Tagesdatum.
 *
 * Am Monatsende wird auf den letzten Tag des Zielmonats GEKÜRZT: 31.07. plus
 * sieben Monate ergibt den 28.02. (bzw. 29.02. im Schaltjahr), nicht den
 * 03.03. — sonst rutschte eine Frist über den Monat hinaus, in dem sie fällig
 * sein soll. Negative Werte rechnen zurück.
 */
export function datePlusMonths(base: string, months: number): string {
  dateFromString(base);
  const [year, month, tag] = base.split('-').map(Number);
  const currentMonth = month - 1 + months;
  const targetYear = year + Math.floor(currentMonth / 12);
  const targetMonth = ((currentMonth % 12) + 12) % 12;
  // Tag 0 des Folgemonats ist der letzte Tag des Zielmonats.
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return `${targetYear}-${twoDigit(targetMonth + 1)}-${twoDigit(Math.min(tag, lastDay))}`;
}

/**
 * Schreibt ein Tagesdatum so, wie es in einer Notiz stehen soll: `12.03.2027`.
 *
 * Der Wortlaut der systemerzeugten Notizen ist Teil der Fachlichkeit
 * („Ansprechpartnerin gewechselt: Anna Berg → Tim Roth, 12.03.2027") — deshalb
 * steht die Formatierung im Backend und nicht nur in der Oberfläche.
 */
export function dayReadable(tag: string): string {
  const verified = dateFromString(tag);
  const [year, month, datePart] = verified.split('-');
  return `${datePart}.${month}.${year}`;
}
