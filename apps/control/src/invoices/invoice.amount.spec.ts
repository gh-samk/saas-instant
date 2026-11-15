import { Prisma } from '.prisma/control-client';
import {
  calculate,
  centAsDecimal,
  centAsText,
  centAsXml,
  decimalAsCent,
  roundCent,
} from './invoice.amount';

describe('Cent-Rechenwerk', () => {
  it('rundet kaufmännisch, auch bei Darstellungsfehlern in Gleitkomma', () => {
    expect(roundCent(93.1)).toBe(93);
    expect(roundCent(93.5)).toBe(94);
    expect(roundCent(-93.5)).toBe(-94);
    // 490,00 € mal 19 % ergibt in Gleitkomma 93.09999999999999. Genau dieser
    // Rest ist der Grund für die ganze Cent-Rechnung.
    expect(roundCent((49_000 * 19) / 100)).toBe(9310);
  });

  it('schreibt Cent für XML mit Punkt und zwei Stellen', () => {
    expect(centAsXml(104_125)).toBe('1041.25');
    expect(centAsXml(-104_125)).toBe('-1041.25');
    expect(centAsXml(5)).toBe('0.05');
    expect(centAsXml(0)).toBe('0.00');
  });

  it('schreibt Cent deutsch für das sichtbare Dokument', () => {
    expect(centAsText(104_125)).toBe('1.041,25');
    expect(centAsText(-500)).toBe('-5,00');
  });

  it('weist gebrochene Cent ab, statt sie stillschweigend zu runden', () => {
    expect(() => centAsXml(1.5)).toThrow(TypeError);
    expect(() => centAsText(1.5)).toThrow(TypeError);
  });

  /**
   * DER WEG IN DIE DATENBANK UND ZURÜCK GEHT ÜBER DIE ZEICHENKETTE.
   *
   * Ein `Decimal` aus `cent / 100` zu bauen hieße, den Grund für die
   * Cent-Rechnung im letzten Schritt wieder aufzugeben.
   */
  it('wandelt verlustfrei zwischen Cent und Decimal', () => {
    for (const cent of [0, 5, 1900, 104_125, -104_125, 99_999_999]) {
      expect(decimalAsCent(centAsDecimal(cent))).toBe(cent);
    }
  });

  it('liest auch ein Decimal, das aus der Datenbank kommt', () => {
    expect(decimalAsCent(new Prisma.Decimal('385.00'))).toBe(38_500);
    expect(decimalAsCent(new Prisma.Decimal('-19.99'))).toBe(-1999);
    expect(decimalAsCent(null)).toBeNull();
  });
});

describe('berechne', () => {
  it('rechnet Netto, Steuer und Brutto je Posten', () => {
    const result = calculate([
      {
        label: 'Einrichtungshonorar',
        quantity: 1,
        unitPriceNetCent: 49_000,
        taxRate: 19,
      },
    ]);
    expect(result.sumNetCent).toBe(49_000);
    expect(result.sumTaxCent).toBe(9310);
    expect(result.sumGrossCent).toBe(58_310);
  });

  /**
   * DIE STEUER WIRD JE SATZ GEBILDET, NICHT JE POSTEN.
   *
   * EN 16931 verlangt genau eine Steueraufteilung (BG-23) je Kombination aus
   * Kategorie und Satz. Die Summe der EINZELN gerundeten Postensteuern ist
   * eine andere Zahl — und jeder ZUGFeRD-Validator meldet die Abweichung als
   * Rechenfehler.
   */
  it('bildet die Steuer über die Summe je Satz, nicht über die Posten', () => {
    // Drei Posten zu 3,33 €: einzeln gerundet 3 × 0,63 = 1,89.
    // Über die Summe: 9,99 × 19 % = 1,898 → 1,90.
    const result = calculate(
      [1, 2, 3].map((number) => ({
        label: `Posten ${number}`,
        quantity: 1,
        unitPriceNetCent: 333,
        taxRate: 19,
      })),
    );
    const sumOfLineTaxes = result.lines.reduce(
      (s, p) => s + p.taxCent,
      0,
    );
    expect(sumOfLineTaxes).toBe(189);
    expect(result.sumTaxCent).toBe(190);
    expect(result.sumGrossCent).toBe(999 + 190);
  });

  it('führt mehrere Steuersätze getrennt auf', () => {
    const result = calculate([
      { label: 'A', quantity: 1, unitPriceNetCent: 10_000, taxRate: 19 },
      { label: 'B', quantity: 1, unitPriceNetCent: 10_000, taxRate: 7 },
    ]);
    expect(result.taxBreakdown.map((t) => t.record).sort((a, b) => a - b)).toEqual([7, 19]);
    expect(result.sumTaxCent).toBe(1900 + 700);
  });

  it('rechnet negative Mengen durch — die Grundlage jeder Stornorechnung', () => {
    const result = calculate([
      { label: 'Storno', quantity: -1, unitPriceNetCent: 38_500, taxRate: 19 },
    ]);
    expect(result.sumNetCent).toBe(-38_500);
    expect(result.sumTaxCent).toBe(-7315);
    expect(result.sumGrossCent).toBe(-45_815);
  });

  it('weist eine Rechnung ohne Posten ab', () => {
    expect(() => calculate([])).toThrow(TypeError);
  });

  it('weist Menge 0 und gebrochene Cent ab', () => {
    expect(() =>
      calculate([
        { label: 'A', quantity: 0, unitPriceNetCent: 100, taxRate: 19 },
      ]),
    ).toThrow(/menge/);
    expect(() =>
      calculate([
        { label: 'A', quantity: 1, unitPriceNetCent: 19.99, taxRate: 19 },
      ]),
    ).toThrow(/ganze Cent/);
  });
});

import { checkTaxCategory } from './invoice.amount';

describe('Steuerkategorien je Posten', () => {
  it('bildet je Kategorie, Satz und Grund eine eigene Steueraufteilung', () => {
    const result = calculate([
      { label: 'a', quantity: 1, unitPriceNetCent: 10_000, taxRate: 19 },
      { label: 'b', quantity: 1, unitPriceNetCent: 5_000, taxRate: 0, taxCategory: 'E', taxExemptionReason: '§ 4 Nr. 21 UStG' },
      { label: 'c', quantity: 1, unitPriceNetCent: 2_000, taxRate: 0, taxCategory: 'Z' },
      { label: 'd', quantity: 1, unitPriceNetCent: 1_000, taxRate: 0, taxCategory: 'E', taxExemptionReason: '§ 4 Nr. 22 UStG' },
    ]);
    expect(result.taxBreakdown.map((t) => [t.category, t.record, t.basisCent, t.taxCent])).toEqual([
      ['S', 19, 10_000, 1_900],
      ['E', 0, 5_000, 0],
      ['Z', 0, 2_000, 0],
      ['E', 0, 1_000, 0],
    ]);
    expect(result.sumTaxCent).toBe(1_900);
    expect(result.sumGrossCent).toBe(19_900);
  });

  it('prüft Kategorie, Satz und Befreiungsgrund', () => {
    expect(checkTaxCategory(1, 'S', 19, undefined)).toEqual({ reason: null, error: [] });
    expect(checkTaxCategory(1, 'Z', 0, undefined)).toEqual({ reason: null, error: [] });
    expect(checkTaxCategory(1, 'E', 0, ' § 4 Nr. 21 ')).toEqual({ reason: '§ 4 Nr. 21', error: [] });
    expect(checkTaxCategory(1, 'S', 0, undefined).error[0]).toMatch(/Regelsteuer/);
    expect(checkTaxCategory(2, 'E', 0, undefined).error[0]).toMatch(/Posten 2.*Befreiungsgrund/);
    expect(checkTaxCategory(1, 'Z', 7, undefined).error[0]).toMatch(/Steuersatz 0/);
    expect(checkTaxCategory(1, 'X', 0, undefined).error[0]).toMatch(/Unbekannte/);
  });

  it('setzt für AE, K und G einen Standardgrund, wenn keiner genannt ist', () => {
    expect(checkTaxCategory(1, 'AE', 0, undefined).reason).toMatch(/§ 13b/);
    expect(checkTaxCategory(1, 'K', 0, undefined).reason).toMatch(/innergemeinschaftlich/i);
    expect(checkTaxCategory(1, 'G', 0, undefined).reason).toMatch(/Ausfuhr/);
  });
});
