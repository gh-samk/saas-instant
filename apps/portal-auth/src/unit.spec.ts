import { createHash } from 'crypto';
import { RateLimiter } from './common/rate-limiter';
import { FieldCrypto } from './common/field-crypto';
import { loadConfig } from './config';
import { passwordProblem } from './accounts/password-policy';
import { isValidChallenge, verifyPkce } from './oidc/pkce';

const baseEnv = {
  PORTAL_ISSUER: 'https://portal.example.test/',
  PORTAL_KEY_SECRET: 'x'.repeat(40),
} as NodeJS.ProcessEnv;

describe('PKCE (S256)', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  it('akzeptiert das Beispiel aus RFC 7636', () => {
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
  });
  it('lehnt falschen oder unzulässigen Verifier ab', () => {
    expect(verifyPkce(`${verifier}x`, challenge)).toBe(false);
    expect(verifyPkce('zu-kurz', challenge)).toBe(false);
    expect(verifyPkce(`${verifier}!`.padEnd(50, 'a'), challenge)).toBe(false);
  });
  it('prüft das Format der Challenge', () => {
    expect(isValidChallenge(challenge)).toBe(true);
    expect(isValidChallenge('kurz')).toBe(false);
    expect(isValidChallenge(`${challenge}=`)).toBe(false);
  });
});

describe('FieldCrypto', () => {
  const crypto = new FieldCrypto('ein-geheimnis-mit-genug-laenge-0123456789');
  it('verschlüsselt hin und zurück, jedes Mal anders', () => {
    const a = crypto.encrypt('JBSWY3DPEHPK3PXP');
    expect(a).not.toContain('JBSWY3DPEHPK3PXP');
    expect(crypto.encrypt('JBSWY3DPEHPK3PXP')).not.toBe(a);
    expect(crypto.decrypt(a)).toBe('JBSWY3DPEHPK3PXP');
  });
  it('erkennt Manipulation und unbekanntes Format', () => {
    const a = crypto.encrypt('geheim');
    const parts = a.split('.');
    parts[3] = Buffer.from('xxxxxx').toString('base64url');
    expect(() => crypto.decrypt(parts.join('.'))).toThrow();
    expect(() => crypto.decrypt('v2.a.b.c')).toThrow();
    expect(() => crypto.decrypt('klartext')).toThrow();
  });
});

describe('RateLimiter', () => {
  it('lässt je Fenster nur so viele Aufrufe zu, danach wieder frei', () => {
    const limiter = new RateLimiter();
    expect([1, 2, 3, 4].map(() => limiter.take('k', 3, 1000, 0))).toEqual([true, true, true, false]);
    expect(limiter.take('anderer', 3, 1000, 0)).toBe(true);
    expect(limiter.take('k', 3, 1000, 1500)).toBe(true);
  });
});

describe('Konfiguration', () => {
  it('liest Issuer ohne Schrägstrich am Ende, leitet Origin und RP-ID ab', () => {
    const c = loadConfig(baseEnv);
    expect(c.issuer).toBe('https://portal.example.test');
    expect(c.origin).toBe('https://portal.example.test');
    expect(c.rpId).toBe('portal.example.test');
    expect(c.cookieSecure).toBe(true);
    expect(c.port).toBe(3100);
  });
  it('bricht ab bei fehlendem Issuer, kurzem Schlüssel und http ohne COOKIE_SECURE=false', () => {
    expect(() => loadConfig({ PORTAL_KEY_SECRET: 'x'.repeat(40) } as NodeJS.ProcessEnv)).toThrow(/PORTAL_ISSUER/);
    expect(() => loadConfig({ ...baseEnv, PORTAL_KEY_SECRET: 'kurz' })).toThrow(/PORTAL_KEY_SECRET/);
    expect(() => loadConfig({ ...baseEnv, PORTAL_ISSUER: 'http://portal.example.test' })).toThrow(/https/);
    expect(loadConfig({ ...baseEnv, PORTAL_ISSUER: 'http://localhost:3100', COOKIE_SECURE: 'false' }).cookieSecure).toBe(false);
  });
  it('lehnt ungültige Proxy-Zahl ab', () => {
    expect(() => loadConfig({ ...baseEnv, PORTAL_TRUST_PROXY: '-1' })).toThrow(/PORTAL_TRUST_PROXY/);
    expect(loadConfig({ ...baseEnv, PORTAL_TRUST_PROXY: '1' }).trustProxy).toBe(1);
  });
});

describe('Passwortregeln', () => {
  it('verlangt Mindestlänge und verbietet die E-Mail-Adresse', () => {
    expect(passwordProblem('kurz', 'a@b.de')).toMatch(/mindestens 12/);
    expect(passwordProblem('a@b.de-a@b.de', 'a@b.de')).toBeNull();
    expect(passwordProblem('A@B.DE'.padEnd(12, 'x'), 'a@b.de')).toBeNull();
    expect(passwordProblem('ein-gutes-Passwort', 'a@b.de')).toBeNull();
  });
});
