/**
 * Dezimalzahlen des Servers, die KEINE Geldbeträge sind — und deshalb leicht
 * durchrutschen.
 *
 * F2 der Designvorgabe nennt die Geldfelder beim Namen und schickt sie durch
 * `formatBetrag`. Zwei Felder kommen aber genauso angelsächsisch herein und
 * standen bis zur Browser-Messung roh im Markup:
 *
 *   `Rechnungsposten.menge`      → "1.000"   (drei Nachkommastellen)
 *   `Rechnungsposten.steuersatz` → "19.00"   (zwei Nachkommastellen)
 *
 * DIE MENGE IST DER GEFÄHRLICHE FALL. „1.000" heißt im Vertrag EINS. Deutsch
 * gelesen heißt derselbe String TAUSEND — und er steht in einer Zeile, in der
 * daneben ein Einzelpreis und ein Gesamtbetrag stehen. Wer eine Rechnung
 * gegenliest, prüft genau diese Spalte. Eine Verwechslung um den Faktor 1000
 * ist die teuerste, die eine Rechnungsansicht anbieten kann.
 *
 * Beide Funktionen kürzen zusätzlich bedeutungslose Nachkommanullen: „1"
 * statt „1,000", „19 %" statt „19,00 %". Was der Server mit fester
 * Stellenzahl schickt, ist eine Eigenschaft seiner Spalte
 * (`Decimal(10,3)`/`Decimal(5,2)`), keine Aussage über die Zahl.
 *
 * Unlesbares wird unverändert durchgereicht, nie stillschweigend zu „0" —
 * dieselbe Regel wie in `formatBetrag`.
 */
function german(value: string): string | null {
  const raw = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return null;
  const [whole = '0', fraction = ''] = raw.split('.');
  const shortened = fraction.replace(/0+$/, '');
  return shortened === '' ? whole : `${whole},${shortened}`;
}

/** Menge eines Rechnungspostens: `"1.000"` → `"1"`, `"2.500"` → `"2,5"`. */
export function formatQuantity(value: string): string {
  return german(value) ?? value;
}

/** Steuersatz in Prozent: `"19.00"` → `"19 %"`, `"7.50"` → `"7,5 %"`. */
export function formatPercent(value: string): string {
  const number = german(value);
  // Schmales geschütztes Leerzeichen vor dem Zeichen, wie `Intl` es bei
  // Währungen setzt — der Prozentwert soll nie am Zeilenende umbrechen.
  return number === null ? value : `${number} %`;
}

/**
 * Derselbe Wert als FELDWERT für ein `input[type=number]`.
 *
 * Punkt statt Komma — das native Zahlenfeld nimmt nichts anderes an — und
 * ohne die bedeutungslosen Nullen des Datenbankformats. Ein Feld, in dem beim
 * Öffnen „1.000" steht, lädt zum Überschreiben mit „1" ein, obwohl beides
 * dasselbe ist; das ist unnötige Unruhe an einer Stelle, an der jede Zahl
 * zweimal gelesen wird.
 */
export function decimalFieldValue(value: string): string {
  const raw = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return raw;
  const number = Number(raw);
  return Number.isFinite(number) ? String(number) : raw;
}
