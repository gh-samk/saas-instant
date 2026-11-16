import { randomBytes } from 'crypto';
import { base32Decode, base32Encode, groupsOfEight } from './base32';

describe('base32', () => {
  it('kodiert nach RFC 4648 (Testvektoren)', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Encode(Buffer.from('f'))).toBe('MY');
  });

  it('Roundtrip für 32 Zufallsbytes, mit Trennern und Kleinschreibung', () => {
    const bytes = randomBytes(32);
    const text = groupsOfEight(base32Encode(bytes));
    expect(text.split('-').slice(0, -1).every((g) => g.length === 8)).toBe(true);
    expect(base32Decode(text)?.equals(bytes)).toBe(true);
    expect(base32Decode(text.toLowerCase().replace(/-/g, ' '))?.equals(bytes)).toBe(true);
  });

  it('lehnt ungültige Zeichen ab', () => {
    expect(base32Decode('ABC1')).toBeNull();
    expect(base32Decode('')).toBeNull();
  });
});
