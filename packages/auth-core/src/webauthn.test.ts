import { describe, expect, it } from 'vitest';
import {
  checkLoginResponse,
  checkRegistrationResponse,
  createLoginOptions,
  createRegistrationOptions,
  transportsFromText,
  transportsToText,
} from './webauthn';

describe('webauthn', () => {
  it('Transporte hin und zurück', () => {
    expect(transportsFromText(null)).toBeUndefined();
    expect(transportsFromText(' , ')).toBeUndefined();
    expect(transportsFromText('usb, nfc')).toEqual(['usb', 'nfc']);
    expect(transportsToText(['usb', 'nfc'])).toBe('usb,nfc');
    expect(transportsToText(undefined)).toBeNull();
  });

  it('Registrierungsoptionen verlangen auffindbaren Passkey mit Nutzerprüfung', async () => {
    const options = await createRegistrationOptions({
      rpName: 'Verwaltung',
      rpId: 'localhost',
      user: { id: 'u1', email: 'a@example.com', name: 'A' },
      existing: [
        { id: '1', credentialId: 'cred-1', publicKey: '', counter: 0, transports: 'usb' },
      ],
    });
    expect(options.rp.id).toBe('localhost');
    expect(options.authenticatorSelection?.residentKey).toBe('required');
    expect(options.authenticatorSelection?.userVerification).toBe('required');
    expect(options.excludeCredentials?.[0]?.id).toBe('cred-1');
  });

  it('Anmeldeoptionen: leere allowCredentials ohne Passkeys', async () => {
    const options = await createLoginOptions('localhost', []);
    expect(options.rpId).toBe('localhost');
    expect(options.userVerification).toBe('required');
    expect(options.allowCredentials ?? []).toHaveLength(0);
  });

  it('Müll als Antwort wird abgelehnt statt zu werfen', async () => {
    const rp = { rpId: 'localhost', origin: 'http://localhost' };
    expect(
      await checkRegistrationResponse({} as never, 'challenge', rp),
    ).toBeNull();
    expect(
      await checkLoginResponse(
        {} as never,
        'challenge',
        { id: '1', credentialId: 'c', publicKey: '', counter: 0, transports: null },
        rp,
      ),
    ).toBeNull();
  });
});
