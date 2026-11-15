import { lockKeyForYear } from '../invoices/number-sequence';
import {
  formatMandateReference,
  blockKeyForMandateYear,
  splitMandateReference,
} from './mandate-number-sequence';

describe('Das Format der Mandatsreferenz', () => {
  it('fuellt auf vier Stellen auf', () => {
    expect(formatMandateReference(2026, 1)).toBe('SOZ-2026-0001');
    expect(formatMandateReference(2026, 42)).toBe('SOZ-2026-0042');
  });

  it('laeuft nicht ueber, sondern wird fuenfstellig', () => {
    // Lieber eine Stelle mehr als ein Ueberlauf — dieselbe Entscheidung wie
    // beim Rechnungskreis.
    expect(formatMandateReference(2026, 10_000)).toBe('SOZ-2026-10000');
    expect(splitMandateReference('SOZ-2026-10000')).toEqual({
      year: 2026,
      running: 10_000,
    });
  });

  it('zerlegt, was es selbst erzeugt', () => {
    for (const running of [1, 9, 10, 999, 1000, 12_345]) {
      expect(splitMandateReference(formatMandateReference(2026, running)))
        .toEqual({ year: 2026, running });
    }
  });

  it('weist ab, was nicht dem Format entspricht', () => {
    for (const broken of [
      'SOZ-2026-abc',
      'SOZ-2026-1',
      '2026-0001',
      'SOZ-26-0001',
      'soz-2026-0001',
      '',
    ]) {
      expect(splitMandateReference(broken)).toBeNull();
    }
  });
});

describe('Die Beratungssperre', () => {
  it('beginnt jedes Jahr neu und behindert die Jahre nicht gegenseitig', () => {
    expect(blockKeyForMandateYear(2026)).not.toBe(
      blockKeyForMandateYear(2027),
    );
  });

  /**
   * DER EIGENTLICHE PUNKT DIESES TESTS. Ein Mandat und eine Rechnung
   * desselben Jahres duerfen sich nicht gegenseitig aufhalten — und schlimmer:
   * Bei gleichem Schluessel wartete die eine Transaktion auf die andere, was
   * unter Last wie ein Haenger aussaehe, den niemand erklaeren kann.
   */
  it('ueberschneidet sich mit KEINEM Schluessel des Rechnungskreises', () => {
    const mandates = new Set<string>();
    const invoices = new Set<string>();
    for (let year = 1970; year <= 9999; year += 1) {
      mandates.add(String(blockKeyForMandateYear(year)));
      invoices.add(String(lockKeyForYear(year)));
    }
    for (const key of mandates) {
      expect(invoices.has(key)).toBe(false);
    }
  });

  it('weist ein unbrauchbares Jahr ab, statt still etwas zu berechnen', () => {
    for (const broken of [0, 1969, 10_000, 2026.5, NaN]) {
      expect(() => blockKeyForMandateYear(broken)).toThrow(TypeError);
    }
  });
});
