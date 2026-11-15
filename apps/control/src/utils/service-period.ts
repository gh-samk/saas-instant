import { today } from '@saas-instant/shared';
import type { PaymentInterval } from '../lib/api';

/**
 * Vorbelegung des Leistungszeitraums nach ZAHLUNGSWEISE.
 *
 * Der Auftrag nennt den häufigsten Stornogrund beim Namen: nicht der
 * Kundenwunsch, sondern der eigene Tippfehler bei Stufe, Zeitraum oder
 * Adresse. Ein leeres Datumsfeld ist die Einladung dazu — wer den
 * Abrechnungsmonat von Hand einträgt, tippt irgendwann den falschen.
 *
 * EIN VORSCHLAG, KEINE SPERRE. Beide Felder bleiben frei editierbar; die
 * Vorbelegung nimmt nur den häufigen Fall vorweg (laufender Monat bei
 * monatlicher, laufendes Jahr bei jährlicher Zahlweise). Ist keine
 * Zahlungsweise hinterlegt, wird nichts geraten: Dann steht in beiden Feldern
 * der heutige Tag, und die Person entscheidet selbst.
 *
 * Gerechnet wird auf Kalendertagen als Zeichenketten — kein `Date`-Objekt mit
 * Uhrzeit, das über Zeitzonen einen Tag springen könnte (Regel 1 der
 * Projektkonventionen).
 */
export function servicePeriodSuggestion(
  paymentInterval: PaymentInterval | null,
  todayDay: string = today(),
): { from: string; until: string } {
  const [year = '', month = ''] = todayDay.split('-');

  if (paymentInterval === 'monthly') {
    return {
      from: `${year}-${month}-01`,
      until: `${year}-${month}-${String(lastDayOfMonth(Number(year), Number(month))).padStart(2, '0')}`,
    };
  }
  if (paymentInterval === 'yearly') {
    return { from: `${year}-01-01`, until: `${year}-12-31` };
  }
  return { from: todayDay, until: todayDay };
}

/** Tag 0 des Folgemonats ist der letzte Tag des Monats — auch im Schaltjahr. */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}
