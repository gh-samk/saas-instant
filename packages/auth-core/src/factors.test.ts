import { describe, expect, it } from 'vitest';
import { factorsAfterRemoval, isSetUp, setUpFactors } from './factors';

const base = { loginCodeEnabled: true, totpSecret: 's', passkeyCount: 2 };

describe('factors', () => {
  it('erkennt eingerichtete Faktoren in fester Reihenfolge', () => {
    expect(setUpFactors(base)).toEqual(['email-code', 'totp', 'passkey']);
    expect(isSetUp({ ...base, totpSecret: null }, 'totp')).toBe(false);
  });
  it('zählt Passkeys einzeln beim Entfernen', () => {
    expect(factorsAfterRemoval(base, 'passkey')).toBe(3);
    expect(
      factorsAfterRemoval(
        { loginCodeEnabled: false, totpSecret: null, passkeyCount: 1 },
        'passkey',
      ),
    ).toBe(0);
    expect(factorsAfterRemoval({ ...base, totpSecret: null }, 'totp')).toBe(3);
  });
});
