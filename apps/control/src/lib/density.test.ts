import { describe, expect, it } from 'vitest';
import { tableText } from './density';

describe('Dichte-Rezept: Textgrößen und -farben', () => {
  const { primary, secondary, data } = tableText.compact;

  it('setzt Sekundärtext nie kleiner als 13 px', () => {
    // `text-xs` (12 px) und rohe Werte unter 13 px sind ausgeschlossen.
    expect(secondary).not.toMatch(/\btext-xs\b/);
    expect(secondary).not.toMatch(/text-\[(\d|1[0-2])(\.\d+)?px\]/);
    expect(secondary).toMatch(/\btext-sm\b/);
  });

  it('setzt Nutzdaten (Organisation, Datum) in Textfarbe, nicht in Sekundärgrau', () => {
    expect(data).toContain('text-text');
    expect(data).not.toContain('text-leise');
    expect(primary).toContain('text-text');
  });

  it('lässt Sekundärtext grau', () => {
    expect(secondary).toContain('text-leise');
  });
});
