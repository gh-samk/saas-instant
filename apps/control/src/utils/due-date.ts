import { dateFromString, today, toDate } from '@saas-instant/shared';
import { t } from '../i18n';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Ganze Kalendertage zwischen zwei Tagesdaten (`ziel - basis`).
 *
 * Gerechnet wird über `zuDatum` (UTC-Mitternacht): Die Sommerzeitumstellung
 * macht einen lokalen Tag 23 oder 25 Stunden lang, und eine Differenz in
 * lokalen Millisekunden zählte dann einen Tag zu wenig oder zu viel.
 */
export function daysUntil(target: string, basis: string = today()): number {
  const a = toDate(dateFromString(basis)).getTime();
  const b = toDate(dateFromString(target)).getTime();
  return Math.round((b - a) / MS_PER_DAY);
}

/**
 * Fälligkeit in Worten, relativ zu heute.
 *
 * Diese Formulierung steht auf dem Dashboard IMMER ZUSÄTZLICH zum exakten
 * `dd.mm.yyyy`, niemals an dessen Stelle: Sie ist eine Lesehilfe für den
 * schnellen Überblick und ersetzt nicht das Datumsformat, das überall sonst
 * in der Anwendung gilt.
 *
 * Bei überfälligen Aufgaben steht das Wort „überfällig" im Text selbst —
 * die rote Farbe der Zeile ist damit nie das alleinige Signal.
 */
export function dueNotice(
  dueAt: string,
  basis: string = today(),
): string {
  const days = daysUntil(dueAt, basis);
  if (days < -1) return t('common.dueDate.text', { value: Math.abs(days) });
  if (days === -1) return t('common.dueDate.text2');
  if (days === 0) return t('common.dueDate.text3');
  if (days === 1) return t('common.dueDate.text4');
  return t('common.dueDate.text5', { days: days });
}
