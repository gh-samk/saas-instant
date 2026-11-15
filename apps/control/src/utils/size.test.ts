import { describe, expect, it } from 'vitest';
import { formatSize } from './size';

describe('formatGroesse', () => {
  it('rechnet in die passende Einheit und schreibt deutsch', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2,0 KB');
    expect(formatSize(2.4 * 1024 ** 3)).toBe('2,4 GB');
  });

  it('lässt die Nachkommastelle weg, wo sie nichts unterscheidet', () => {
    expect(formatSize(15 * 1024 ** 2)).toBe('15 MB');
    expect(formatSize(1023)).toBe('1.023 B');
  });

  it('behauptet bei unsinnigen Werten nichts', () => {
    expect(formatSize(-1)).toBe('—');
    expect(formatSize(Number.NaN)).toBe('—');
  });
});
