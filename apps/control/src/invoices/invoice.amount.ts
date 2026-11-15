import { Prisma } from '.prisma/control-client';

/**
 * Das Rechenwerk einer Rechnung — GANZE CENT, kein Gleitkomma.
 *
 * Übernommen aus `tools/invoice-renderer/src/rechnung.mjs`, dem
 * belegten Erkundungsschritt. Die Begründung von dort gilt unverändert:
 * 490,00 € mal 19 % ergibt in Gleitkomma 93,09999999999999; über mehrere
 * Posten summieren sich solche Reste zu Abweichungen, die jeder
 * ZUGFeRD-Validator als Rechenfehler meldet.
 *
 * WARUM DIE DATEI HIER LIEGT UND NICHT IMPORTIERT WIRD: Der Prototyp ist
 * reines ESM ohne Typen und liegt außerhalb von `apps/`. Das
 * Auslieferungsimage von `apps/control` enthält nur `apps/control/dist` — ein
 * Import quer über die Verzeichnisgrenze liefe lokal und fehlte im Container.
 * Die Zahlenlogik ist deshalb hier, mit Typen; der GELÖSTE Teil (PDF/A-3 mit
 * eingebettetem XML samt Selbstprüfung) bleibt vollständig im Container und
 * wird nur aufgerufen.
 */

/** Kaufmännisch auf ganze Cent runden (halbe Cent aufwärts, auch negativ). */
export function roundCent(number: number): number {
  if (!Number.isFinite(number)) {
    throw new TypeError(`roundCent erwartet eine endliche Zahl, erhielt: ${number}`);
  }
  // Der Zuschlag von 1e-9 fängt Darstellungsfehler ab: 2.675 liegt in
  // Gleitkomma knapp unter der Mitte und würde sonst abgerundet.
  return Math.round(number + (number >= 0 ? 1e-9 : -1e-9));
}

/** Cent als Dezimalzahl mit Punkt, wie sie in XML gehört: `-1041.25`. */
export function centAsXml(cent: number): string {
  if (!Number.isInteger(cent)) {
    throw new TypeError(`centAsXml erwartet ganze Cent, erhielt: ${cent}`);
  }
  const sign = cent < 0 ? '-' : '';
  const amount = Math.abs(cent);
  return `${sign}${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`;
}

/** Cent deutsch für das sichtbare Dokument: `1.041,25`. */
export function centAsText(cent: number): string {
  if (!Number.isInteger(cent)) {
    throw new TypeError(`centAsText erwartet ganze Cent, erhielt: ${cent}`);
  }
  return (cent / 100).toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Cent als `Decimal(10,2)` für die Datenbank.
 *
 * Bewusst über die Zeichenkette und nicht über `cent / 100`: Ein Decimal aus
 * einer Gleitkommazahl zu bauen, hieße den Grund für die Cent-Rechnung im
 * letzten Schritt wieder aufzugeben.
 */
export function centAsDecimal(cent: number): Prisma.Decimal {
  return new Prisma.Decimal(centAsXml(cent));
}

/**
 * `Decimal(10,2)` zurück in ganze Cent.
 *
 * Ebenfalls über die Zeichenkette: `Number(decimal)` ginge durch Gleitkomma.
 */
export function decimalAsCent(value: Prisma.Decimal | string | null): number | null {
  if (value === null) return null;
  const text = typeof value === 'string' ? value : value.toFixed(2);
  const negative = text.trimStart().startsWith('-');
  const [whole = '0', fraction = '0'] = text.replace('-', '').trim().split('.');
  const cent = Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
  return negative ? -cent : cent;
}

/**
 * Steuerkategorien nach UNTDID 5305, soweit das System sie ausstellt.
 *
 * S = Regelsatz, Z = Nullsatz, E = steuerbefreit, AE = Steuerschuldnerschaft
 * des Leistungsempfängers (§ 13b UStG), K = innergemeinschaftliche Lieferung,
 * G = Ausfuhr, O = nicht steuerbar.
 */
export const TAX_CATEGORIES = ['S', 'Z', 'E', 'AE', 'K', 'G', 'O'] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];

/** Kategorien, bei denen EN 16931 einen Befreiungsgrund (BT-120/121) verlangt. */
const NEEDS_REASON: readonly TaxCategory[] = ['E', 'AE', 'K', 'G', 'O'];

const DEFAULT_REASON: Partial<Record<TaxCategory, string>> = {
  AE: 'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge, § 13b UStG)',
  K: 'Steuerfreie innergemeinschaftliche Lieferung (§ 4 Nr. 1b UStG)',
  G: 'Steuerfreie Ausfuhrlieferung (§ 4 Nr. 1a UStG)',
};

/**
 * Prüft Kategorie, Satz und Befreiungsgrund eines Postens und liefert den
 * wirksamen Grund (bei AE/K/G mit Standardtext, wenn keiner genannt ist).
 * Gibt Fehlermeldungen als Text zurück, wirft nicht.
 */
export function checkTaxCategory(
  row: number,
  category: string,
  taxRate: number,
  reason: string | undefined | null,
): { reason: string | null; error: string[] } {
  const error: string[] = [];
  if (!(TAX_CATEGORIES as readonly string[]).includes(category)) {
    return {
      reason: null,
      error: [`Posten ${row}: Unbekannte Steuerkategorie „${category}".`],
    };
  }
  const c = category as TaxCategory;
  if (c === 'S' && taxRate <= 0) {
    error.push(
      `Posten ${row}: Die Regelsteuer (S) braucht einen Satz über 0 — ` +
        'für 0 % bitte Kategorie Z oder eine Befreiung wählen.',
    );
  }
  if (c !== 'S' && taxRate !== 0) {
    error.push(
      `Posten ${row}: Kategorie ${c} verlangt den Steuersatz 0.`,
    );
  }
  const text = reason?.trim() || DEFAULT_REASON[c] || null;
  if (NEEDS_REASON.includes(c) && text === null) {
    error.push(
      `Posten ${row}: Für Kategorie ${c} fehlt der Befreiungsgrund (z. B. „§ 4 Nr. 21 UStG").`,
    );
  }
  return { reason: c === 'S' || c === 'Z' ? null : text, error };
}

/** Ein Posten, wie er in die Rechnung eingeht. */
export interface LineInput {
  label: string;
  description?: string;
  /** Menge mit bis zu drei Nachkommastellen (`Decimal(10,3)`). */
  quantity: number;
  unitPriceNetCent: number;
  taxRate: number;
  /** UN/ECE Rec. 20, z. B. `C62` (Stück/Pauschale), `MON`, `ANN`. */
  unit?: string;
  /** Abrechnungszeitraum des einzelnen Postens. */
  period?: { from: string; until: string };
  /** Steuerkategorie nach UNTDID 5305; Vorgabe `S`. */
  taxCategory?: TaxCategory;
  /** Befreiungsgrund (BT-120) für E/AE/K/G/O. */
  taxExemptionReason?: string;
}

/** Ein Posten mit allen abgeleiteten Beträgen. */
export interface CalculatedLine extends LineInput {
  /** Positionsnummer, ab `1`, als Zeichenkette (so verlangt es CII). */
  row: string;
  netCent: number;
  taxCent: number;
  grossCent: number;
}

/** Eine Steueraufteilung je Kombination aus Kategorie und Satz (BG-23). */
export interface TaxShare {
  category: string;
  record: number;
  exemptionReason?: string;
  basisCent: number;
  taxCent: number;
}

export interface CalculationResult {
  lines: CalculatedLine[];
  taxBreakdown: TaxShare[];
  sumNetCent: number;
  sumTaxCent: number;
  sumGrossCent: number;
}

/**
 * Rechnet Posten, Steueraufteilung und Summen aus.
 *
 * DIE STEUER WIRD JE SATZ GEBILDET, NICHT JE POSTEN. EN 16931 verlangt genau
 * eine Steueraufteilung (BG-23) je Kombination aus Kategorie und Satz; die
 * Summe der einzeln gerundeten Postensteuern wäre bei Rundung nicht dieselbe
 * Zahl, und der Validator meldete einen Rechenfehler.
 *
 * Der Steuerbetrag AM POSTEN wird trotzdem geführt — die Spalte
 * `Rechnungsposten.steuerbetrag` verlangt ihn, und die Oberfläche zeigt ihn.
 * Er ist nachrichtlich; maßgeblich für die Summe ist die Aufteilung.
 */
export function calculate(inputs: LineInput[]): CalculationResult {
  if (inputs.length === 0) {
    throw new TypeError('Eine Rechnung braucht mindestens einen Posten.');
  }

  const lines: CalculatedLine[] = inputs.map((input, index) => {
    const number = index + 1;
    if (!Number.isInteger(input.unitPriceNetCent)) {
      throw new TypeError(
        `Posten ${number}: unitPriceNetCent muss ganze Cent sein.`,
      );
    }
    if (!Number.isFinite(input.quantity) || input.quantity === 0) {
      throw new TypeError(`Posten ${number}: menge darf nicht 0 sein.`);
    }
    if (!Number.isFinite(input.taxRate) || input.taxRate < 0) {
      throw new TypeError(`Posten ${number}: steuersatz muss 0 oder größer sein.`);
    }
    const netCent = roundCent(input.unitPriceNetCent * input.quantity);
    const taxCent = roundCent((netCent * input.taxRate) / 100);
    return {
      ...input,
      row: String(number),
      netCent,
      taxCent,
      grossCent: netCent + taxCent,
    };
  });

  const byRecord = new Map<string, TaxShare>();
  for (const p of lines) {
    const category = p.taxCategory ?? 'S';
    const key = `${category}|${p.taxRate}|${p.taxExemptionReason ?? ''}`;
    const entry = byRecord.get(key) ?? {
      category,
      record: p.taxRate,
      ...(p.taxExemptionReason ? { exemptionReason: p.taxExemptionReason } : {}),
      basisCent: 0,
      taxCent: 0,
    };
    entry.basisCent += p.netCent;
    byRecord.set(key, entry);
  }
  const taxBreakdown = [...byRecord.values()].map((share) => ({
    ...share,
    taxCent: roundCent((share.basisCent * share.record) / 100),
  }));

  const sumNetCent = lines.reduce((s, p) => s + p.netCent, 0);
  const sumTaxCent = taxBreakdown.reduce((s, t) => s + t.taxCent, 0);

  return {
    lines,
    taxBreakdown,
    sumNetCent,
    sumTaxCent,
    sumGrossCent: sumNetCent + sumTaxCent,
  };
}
