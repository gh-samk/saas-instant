import { describe, expect, it } from 'vitest';
import { linesAmounts, roundCent, sums } from './invoice-amount';

describe('rundeCent', () => {
  it('rundet halbe Cent aufwärts — auch die, die Gleitkomma knapp verfehlt', () => {
    expect(roundCent(2.675 * 100 * 0.01)).toBe(3);
    expect(roundCent(0.5)).toBe(1);
    expect(roundCent(-0.5)).toBe(-1);
  });
});

describe('postenBetraege', () => {
  it('rechnet wie das Backend: 490,00 € mal 19 % ergibt 93,10 € Steuer', () => {
    // Über Gleitkomma wären es 93,09999999999999 — genau der Rest, den jeder
    // ZUGFeRD-Validator als Rechenfehler meldet.
    const b = linesAmounts({
      quantity: '1',
      unitPriceNet: '490.00',
      taxRate: '19',
    });
    expect(b.netCent).toBe(49000);
    expect(b.taxCent).toBe(9310);
    expect(b.grossCent).toBe(58310);
  });

  it('nimmt Mengen mit Nachkommastellen', () => {
    const b = linesAmounts({
      quantity: '2.5',
      unitPriceNet: '19.99',
      taxRate: '19',
    });
    expect(b.netCent).toBe(4998);
  });

  it('meldet einen unvollständigen Posten, statt 0,00 € zu behaupten', () => {
    expect(
      linesAmounts({ quantity: '', unitPriceNet: '10', taxRate: '19' })
        .complete,
    ).toBe(false);
    expect(
      linesAmounts({ quantity: '1', unitPriceNet: 'abc', taxRate: '19' })
        .complete,
    ).toBe(false);
  });

  it('trägt das Vorzeichen einer Stornoposition durch', () => {
    const b = linesAmounts({
      quantity: '-1',
      unitPriceNet: '490.00',
      taxRate: '19',
    });
    expect(b.netCent).toBe(-49000);
    expect(b.taxCent).toBe(-9310);
  });
});

describe('summen', () => {
  it('bildet die Steuer JE SATZ, nicht je Posten', () => {
    // Drei Posten zu 0,05 € mit 19 %: je Posten gerundet ergäbe 3 × 1 Cent =
    // 3 Cent, je Satz gerundet sind es rundeCent(15 * 0,19) = 3 Cent — hier
    // gleich. Der Unterschied zeigt sich bei 0,03 €: je Posten 3 × 1 Cent,
    // je Satz rundeCent(9 * 0,19) = 2 Cent. Maßgeblich ist die zweite Zahl.
    const lines = [
      { quantity: '1', unitPriceNet: '0.03', taxRate: '19' },
      { quantity: '1', unitPriceNet: '0.03', taxRate: '19' },
      { quantity: '1', unitPriceNet: '0.03', taxRate: '19' },
    ];
    expect(lines.map((p) => linesAmounts(p).taxCent)).toEqual([1, 1, 1]);
    expect(sums(lines)).toEqual({
      netCent: 9,
      taxCent: 2,
      grossCent: 11,
    });
  });

  it('trennt nach Steuersatz', () => {
    expect(
      sums([
        { quantity: '1', unitPriceNet: '100', taxRate: '19' },
        { quantity: '1', unitPriceNet: '100', taxRate: '7' },
      ]),
    ).toEqual({ netCent: 20000, taxCent: 1900 + 700, grossCent: 22600 });
  });

  it('überspringt unvollständige Zeilen, statt die Summe auszublenden', () => {
    expect(
      sums([
        { quantity: '1', unitPriceNet: '100', taxRate: '19' },
        { quantity: '', unitPriceNet: '', taxRate: '19' },
      ]),
    ).toEqual({ netCent: 10000, taxCent: 1900, grossCent: 11900 });
  });
});
