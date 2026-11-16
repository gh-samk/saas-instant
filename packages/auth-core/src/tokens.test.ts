import { describe, expect, it } from 'vitest';
import {
  generateCsrfToken,
  generateNumericCode,
  generateToken,
  hashToken,
  sameConstantTime,
} from './tokens';

describe('tokens', () => {
  it('Token ist URL-sicher, 256 Bit, einmalig', () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(a);
  });

  it('Hash ist SHA-256 als Hex und deterministisch', () => {
    expect(hashToken('x')).toBe(
      '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881',
    );
  });

  it('CSRF-Token hat 48 Hexzeichen', () => {
    expect(generateCsrfToken()).toMatch(/^[0-9a-f]{48}$/);
  });

  it('zeitkonstanter Vergleich', () => {
    expect(sameConstantTime('abc', 'abc')).toBe(true);
    expect(sameConstantTime('abc', 'abd')).toBe(false);
    expect(sameConstantTime('abc', 'abcd')).toBe(false);
  });

  it('Zahlen-Code hat genau die verlangte Länge, nur Ziffern', () => {
    expect(generateNumericCode(8)).toMatch(/^\d{8}$/);
    expect(generateNumericCode(0)).toBe('');
  });
});
