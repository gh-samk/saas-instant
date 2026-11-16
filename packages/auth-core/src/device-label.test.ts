import { describe, expect, it } from 'vitest';
import { labelFromUserAgent } from './device-label';

describe('labelFromUserAgent', () => {
  it('ohne User-Agent', () => {
    expect(labelFromUserAgent('Merk-Gerät', null)).toBe(
      'Merk-Gerät · Unbekanntes Gerät',
    );
  });
  it('erkennt Browser und System', () => {
    expect(
      labelFromUserAgent(
        'Merk-Gerät',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605 Version/17 Safari/605',
      ),
    ).toBe('Merk-Gerät · Safari auf macOS');
    expect(
      labelFromUserAgent('X', 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Edg/120'),
    ).toBe('X · Edge auf Windows');
  });
});
