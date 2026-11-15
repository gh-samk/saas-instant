import {
  formatNumber,
  lockKeyForYear,
  splitNumber,
} from './number-sequence';

/**
 * Die reinen Bausteine des Nummernkreises.
 *
 * Die eigentliche Eigenschaft — keine Lücke, keine Doppelnummer unter
 * Nebenläufigkeit — lässt sich hier NICHT prüfen: JavaScript ist einfädig, ein
 * Rennen kann in einem Unit-Test gar nicht entstehen. Das steht in
 * `invoice.integration.spec.ts` und läuft gegen eine echte Datenbank.
 */
describe('formatNumber', () => {
  it('schreibt JJJJ-NNN mit drei Stellen', () => {
    expect(formatNumber(2026, 1)).toBe('2026-001');
    expect(formatNumber(2026, 42)).toBe('2026-042');
    expect(formatNumber(2026, 999)).toBe('2026-999');
  });

  /**
   * AB DER TAUSENDSTEN RECHNUNG WIRD DIE NUMMER VIERSTELLIG.
   *
   * Lieber eine Stelle mehr als ein Überlauf. Genau deshalb vergleicht
   * `assignNextNumber` NUMERISCH und nicht alphabetisch: Als Text sortiert
   * `2026-1000` vor `2026-999`, und der Kreis fiele auf 1000 zurück — eine
   * Doppelnummer, die niemand kommen sieht.
   */
  it('wächst über 999 hinaus, statt überzulaufen', () => {
    expect(formatNumber(2026, 1000)).toBe('2026-1000');
    expect('2026-1000' < '2026-999').toBe(true);
    expect(
      (splitNumber('2026-1000')?.running ?? 0) >
        (splitNumber('2026-999')?.running ?? 0),
    ).toBe(true);
  });
});

describe('splitNumber', () => {
  it('zerlegt eine gültige Nummer', () => {
    expect(splitNumber('2026-001')).toEqual({ year: 2026, running: 1 });
    expect(splitNumber('2027-1234')).toEqual({ year: 2027, running: 1234 });
  });

  it('weist alles ab, was nicht dem Format entspricht', () => {
    for (const nonsense of [
      '2026-abc',
      '2026-1',
      '26-001',
      '20261-1',
      '2026_001',
      '',
      'Rechnung',
    ]) {
      expect(splitNumber(nonsense)).toBeNull();
    }
  });
});

describe('lockKeyForYear', () => {
  it('gibt je Jahr einen eigenen Schlüssel', () => {
    expect(lockKeyForYear(2026)).not.toBe(lockKeyForYear(2027));
  });

  it('ist stabil — derselbe Aufruf, derselbe Schlüssel', () => {
    expect(lockKeyForYear(2026)).toBe(lockKeyForYear(2026));
  });

  it('bleibt im Bereich eines signierten 64-Bit-Wertes', () => {
    const key = lockKeyForYear(9999);
    expect(key).toBeLessThan(2n ** 63n);
    expect(key).toBeGreaterThan(0n);
  });

  it('weist ein unbrauchbares Jahr ab', () => {
    expect(() => lockKeyForYear(1969)).toThrow(TypeError);
    expect(() => lockKeyForYear(10_000)).toThrow(TypeError);
    expect(() => lockKeyForYear(2026.5)).toThrow(TypeError);
  });
});
