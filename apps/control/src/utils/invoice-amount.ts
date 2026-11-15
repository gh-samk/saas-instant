import { centFromInput } from './amount';

/**
 * Die LIVE-VORSCHAU des Rechnungsformulars — kein zweites Rechenwerk.
 *
 * Sie spiegelt `apps/control/src/rechnung/rechnung.betrag.ts` Zeile für Zeile,
 * damit auf dem Bildschirm keine andere Zahl steht als die, die der Server
 * gleich festschreibt. Verbindlich ist AUSSCHLIESSLICH der Server: Er rechnet
 * beim Speichern erneut, und clientseitig wird nie etwas gespeichert. Ein
 * Rundungsunterschied wäre deshalb ein Anzeigefehler, kein Vertrauensbruch —
 * ärgerlich genug, um ihn mit denselben Regeln zu vermeiden.
 *
 * ZWEI REGELN AUS DEM BACKEND, die man leicht falsch nachbaut:
 *
 * 1. GANZE CENT, NIE GLEITKOMMA. 490,00 € mal 19 % ergibt in Gleitkomma
 *    93,09999999999999; über mehrere Posten summieren sich solche Reste zu
 *    Abweichungen, die jeder ZUGFeRD-Validator als Rechenfehler meldet.
 * 2. DIE STEUER WIRD JE SATZ GEBILDET, NICHT JE POSTEN. EN 16931 verlangt
 *    genau eine Steueraufteilung je Satz; die Summe der einzeln gerundeten
 *    Postensteuern wäre bei Rundung nicht dieselbe Zahl. Der Steuerbetrag am
 *    einzelnen Posten wird trotzdem geführt und angezeigt — er ist
 *    nachrichtlich.
 */

/** Kaufmännisch auf ganze Cent runden (halbe Cent aufwärts, auch negativ). */
export function roundCent(number: number): number {
  if (!Number.isFinite(number)) return 0;
  // Der Zuschlag von 1e-9 fängt Darstellungsfehler ab: 2.675 liegt in
  // Gleitkomma knapp unter der Mitte und würde sonst abgerundet.
  return Math.round(number + (number >= 0 ? 1e-9 : -1e-9));
}

/** Ein Posten, wie ihn das Formular führt: alles als Text. */
export interface LinesFields {
  quantity: string;
  unitPriceNet: string;
  taxRate: string;
}

export interface LinesAmounts {
  netCent: number;
  taxCent: number;
  grossCent: number;
  /** Fehlt eine Angabe oder ist sie unlesbar? Dann ist die Vorschau leer. */
  complete: boolean;
}

function numberFrom(text: string): number | null {
  const raw = text.trim().replace(',', '.');
  if (raw === '') return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

/** Die Beträge eines einzelnen Postens — Steuer hier nachrichtlich je Posten. */
export function linesAmounts(fields: LinesFields): LinesAmounts {
  const quantity = numberFrom(fields.quantity);
  const unitPriceCent = centFromInput(fields.unitPriceNet);
  const taxRate = numberFrom(fields.taxRate);
  if (quantity === null || unitPriceCent === null || taxRate === null) {
    return { netCent: 0, taxCent: 0, grossCent: 0, complete: false };
  }
  const netCent = roundCent(unitPriceCent * quantity);
  const taxCent = roundCent((netCent * taxRate) / 100);
  return {
    netCent,
    taxCent,
    grossCent: netCent + taxCent,
    complete: true,
  };
}

export interface Sums {
  netCent: number;
  taxCent: number;
  grossCent: number;
}

/**
 * Die Summen über alle Posten — Steuer JE SATZ gebildet.
 *
 * Unvollständige Posten zählen mit 0 mit, statt die ganze Summe auszublenden:
 * Wer die dritte Zeile gerade tippt, will sehen, was die ersten beiden ergeben.
 */
export function sums(lines: LinesFields[]): Sums {
  const afterSet = new Map<number, number>();
  let netCent = 0;

  for (const p of lines) {
    const single = linesAmounts(p);
    if (!single.complete) continue;
    netCent += single.netCent;
    const set = numberFrom(p.taxRate) ?? 0;
    afterSet.set(set, (afterSet.get(set) ?? 0) + single.netCent);
  }

  let taxCent = 0;
  for (const [set, basis] of afterSet) {
    taxCent += roundCent((basis * set) / 100);
  }

  return { netCent, taxCent, grossCent: netCent + taxCent };
}
