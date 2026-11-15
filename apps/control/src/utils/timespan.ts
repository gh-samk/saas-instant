import { today } from '@saas-instant/shared';
import { daysUntil } from './due-date';
import { t } from '../i18n';

/**
 * Zeitspanne SEIT einem vergangenen Tagesdatum, in Worten.
 *
 * Das Gegenstück zu `faelligkeitsHinweis`, die für die Zukunft formuliert.
 * Steht immer NEBEN dem exakten `dd.mm.yyyy`, nie an dessen Stelle — dieselbe
 * Regel wie auf dem Dashboard.
 */
export function beforeTimespan(date: string, basis: string = today()): string {
  const days = -daysUntil(date, basis);
  if (days <= 0) return t('common.timespan.text');
  if (days === 1) return t('common.timespan.text2');
  return t('common.timespan.text3', { days: days });
}

/**
 * Wie lange ein laufender Vorgang schon dauert — grob, in Minuten.
 *
 * BEWUSST KEIN SEKUNDENGENAUER ZÄHLER. Der Zeitpunkt des Fertigwerdens ist
 * unbekannt; eine laufende Uhr behauptete eine Präzision, die es nicht gibt.
 * Unterhalb einer Minute steht deshalb „seit weniger als einer Minute", ab
 * einer Stunde wird auf Stunden umgestellt.
 */
export function runtimeInWords(begin: string, now: number = Date.now()): string {
  const start = Date.parse(begin);
  if (Number.isNaN(start)) return t('common.timespan.text4');
  const minutes = Math.floor((now - start) / 60_000);
  if (minutes < 1) return t('common.timespan.text5');
  if (minutes === 1) return t('common.timespan.text6');
  if (minutes < 60) return t('common.timespan.text7', { minutes: minutes });
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? t('common.timespan.text8') : t('common.timespan.text9', { hours: hours });
}

/** Minuten seit einem technischen Zeitstempel; `0`, wenn er unlesbar ist. */
export function minutesSince(begin: string, now: number = Date.now()): number {
  const start = Date.parse(begin);
  if (Number.isNaN(start)) return 0;
  return Math.max(0, Math.floor((now - start) / 60_000));
}
