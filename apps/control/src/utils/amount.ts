/**
 * Geldbetrag zur ANZEIGE.
 *
 * Der Server liefert `abweichenderBetrag` als Zeichenkette („1234.50"), weil
 * ein Decimal(10,2) über eine Gleitkommazahl zu reichen hieße, Cent zu
 * riskieren. Zum Anzeigen wird genau einmal umgewandelt; das Eingabefeld
 * arbeitet weiterhin mit dem nativen `type="number"` und dem Punkt als
 * Dezimaltrenner.
 *
 * Ein unlesbarer Wert wird nicht stillschweigend zu „0,00 €", sondern
 * unverändert durchgereicht — sonst behauptete die Oberfläche einen Betrag,
 * den niemand so eingegeben hat.
 */
export function formatAmount(value: string): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
  }).format(number);
}

/**
 * Ganze Cent zur ANZEIGE.
 *
 * Zweite Bauform desselben Helfers, weil das Rechnungsmodul Geld in zwei
 * Gestalten liefert: als Dezimal-Zeichenkette (`RechnungAntwort.summeBrutto`)
 * und als ganze Cent (`Preisstufe.monatlichCent`, `summeBruttoCent`). Beide
 * müssen am Ende gleich aussehen; ein `cent / 100` mitten im Markup wäre der
 * Punkt, an dem die Gleitkomma-Disziplin des Backends verloren ginge.
 *
 * Umgewandelt wird deshalb über die Zeichenkette, nicht über die Division.
 */
export function formatAmountCent(cent: number): string {
  if (!Number.isFinite(cent)) return '—';
  const rounded = Math.round(cent);
  const sign = rounded < 0 ? '-' : '';
  const amount = Math.abs(rounded);
  return formatAmount(
    `${sign}${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`,
  );
}

/**
 * Eine EINGETIPPTE Euro-Angabe in ganze Cent.
 *
 * Das Gegenstück zu `formatBetragCent`: Die DTOs des Rechnungsmoduls nehmen
 * ausschließlich ganze Cent an, die Eingabefelder liefern aber Text. Der Weg
 * über `Math.round(Number(text) * 100)` wäre der bequeme und der falsche —
 * `Number('19.99') * 100` ist 1998.9999999999998, und genau solche Reste sind
 * der Grund, warum das Backend gar nicht erst mit Gleitkomma rechnet.
 *
 * Deshalb wird die Zeichenkette zerlegt: Vorzeichen, Vorkommastellen,
 * höchstens zwei Nachkommastellen. Der Punkt ist der Dezimaltrenner (das
 * native `input[type=number]` liefert ihn so); ein Komma wird zusätzlich
 * angenommen, weil es sich auf einer deutschen Tastatur von selbst eintippt.
 *
 * `null` heißt „nicht lesbar" — nie eine stille 0.
 */
export function centFromInput(text: string): number | null {
  const raw = text.trim().replace(',', '.');
  if (!/^-?\d*\.?\d*$/.test(raw) || raw === '' || raw === '-' || raw === '.') {
    return null;
  }
  const negative = raw.startsWith('-');
  const [whole = '0', fraction = ''] = raw.replace('-', '').split('.');
  if (fraction.length > 2) return null;
  const cent =
    Number(whole || '0') * 100 + Number(fraction.padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(cent)) return null;
  return negative ? -cent : cent;
}

/**
 * Ganze Cent als Feldwert für ein `input[type=number]`: `1999` → `"19.99"`.
 *
 * Bewusst mit Punkt und ohne Tausendertrenner — ein deutsch formatierter Wert
 * wäre für das native Zahlenfeld unlesbar und käme leer zurück.
 */
export function centAsFieldValue(cent: number): string {
  const sign = cent < 0 ? '-' : '';
  const amount = Math.abs(Math.round(cent));
  return `${sign}${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`;
}
