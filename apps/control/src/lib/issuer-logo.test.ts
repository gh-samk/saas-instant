import { describe, expect, it } from 'vitest';
import { LOGO_MAX_BYTES, validateLogoFile } from './issuer-logo';

describe('validateLogoFile', () => {
  it('nimmt PNG und JPEG bis 512 KB an', () => {
    expect(validateLogoFile({ type: 'image/png', size: 1000 })).toBeNull();
    expect(validateLogoFile({ type: 'image/jpeg', size: LOGO_MAX_BYTES })).toBeNull();
  });
  it('lehnt andere Typen ab', () => {
    for (const type of ['image/svg+xml', 'image/gif', 'application/pdf', '']) {
      expect(validateLogoFile({ type, size: 1000 })).toBe('type');
    }
  });
  it('lehnt zu große und leere Dateien ab', () => {
    expect(validateLogoFile({ type: 'image/png', size: LOGO_MAX_BYTES + 1 })).toBe('size');
    expect(validateLogoFile({ type: 'image/png', size: 0 })).toBe('empty');
  });
});
