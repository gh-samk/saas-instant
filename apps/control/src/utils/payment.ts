import { centFromInput } from './amount';

/**
 * Zahlungsart im Dialog „Zahlung erfassen“.
 *
 * Der Server kennt nur EINEN Wert: den kumulierten Gesamtstand
 * (`paidAmountCent`). Die Oberfläche fragt dagegen in der Sprache der
 * Überweisung — „voll bezahlt“ oder „so viel kam jetzt dazu“ — und rechnet
 * hier genau einmal um.
 */
export type PaymentMode = 'full' | 'partial' | 'correct';

/**
 * Der Gesamtstand, den der Server bekommt, oder `null`, wenn die Eingabe
 * unlesbar oder keine positive Zahlung ist.
 *
 * - `full`: die volle Rechnungssumme, egal was schon erfasst war.
 * - `partial`: bisher Bezahltes PLUS die jetzt eingetippte Zahlung. Wer eine
 *   Rechnung in zwei Raten bezahlt, tippt zweimal die Rate — nie die Summe.
 * - `correct` [M13]: der eingetippte Betrag IST der neue Gesamtstand, auch 0
 *   (alles zurücknehmen). So lässt sich eine falsch erfasste Zahlung
 *   berichtigen, ohne dass der Server einen Löschpfad kennt. Nicht negativ.
 */
export function cumulativePaidCent(
  mode: PaymentMode,
  sumGrossCent: number,
  alreadyPaidCent: number,
  typedAmount: string,
): number | null {
  if (mode === 'full') return sumGrossCent;
  if (mode === 'correct') {
    const total = centFromInput(typedAmount);
    return total === null || total < 0 ? null : total;
  }
  const added = centFromInput(typedAmount);
  if (added === null || added <= 0) return null;
  return alreadyPaidCent + added;
}
