import { authModeFrom, portalLogoutUrl, readSsoSettings } from './sso-settings';
import { assertAllowedReturnPath } from './return-path';
import { STEP_UP_VALID_MS, stepUpFresh } from './step-up';

const env = (values: Record<string, string>) => (key: string) => values[key];

describe('AUTH_MODE', () => {
  it('ist ohne Angabe oder leer `single`', () => {
    expect(authModeFrom(env({}))).toBe('single');
    expect(authModeFrom(env({ AUTH_MODE: '' }))).toBe('single');
    expect(authModeFrom(env({ AUTH_MODE: ' Single ' }))).toBe('single');
  });

  it('kennt `portal`', () => {
    expect(authModeFrom(env({ AUTH_MODE: 'portal' }))).toBe('portal');
  });

  it('bricht bei einem unbekannten Wert ab', () => {
    expect(() => authModeFrom(env({ AUTH_MODE: 'oidc' }))).toThrow(/AUTH_MODE/);
  });
});

describe('readSsoSettings', () => {
  const full = {
    AUTH_MODE: 'portal',
    PORTAL_ISSUER: 'https://portal.example.test/',
    PORTAL_CLIENT_ID: 'meine-verwaltung',
    PORTAL_CLIENT_SECRET: 'geheim',
    CONTROL_APP_URL: 'https://verwaltung.example.test',
  };

  it('verlangt im Modus portal Aussteller, Client-Kennung und Geheimnis', () => {
    for (const name of ['PORTAL_ISSUER', 'PORTAL_CLIENT_ID', 'PORTAL_CLIENT_SECRET']) {
      const without = { ...full } as Record<string, string>;
      delete without[name];
      expect(() => readSsoSettings(env(without))).toThrow(new RegExp(name));
    }
    expect(() =>
      readSsoSettings(env({ ...full, PORTAL_CLIENT_SECRET: '   ' })),
    ).toThrow(/PORTAL_CLIENT_SECRET/);
  });

  it('liest im Modus single nichts und verlangt nichts', () => {
    expect(readSsoSettings(env({})).mode).toBe('single');
  });

  it('normalisiert den Aussteller und nimmt ihn als interne Adresse', () => {
    const settings = readSsoSettings(env(full));
    expect(settings.issuer).toBe('https://portal.example.test');
    expect(settings.internalUrl).toBe('https://portal.example.test');
    expect(settings.postLogoutUrl).toBe('https://verwaltung.example.test/');
  });

  it('trennt die interne Adresse für Token und JWKS', () => {
    const settings = readSsoSettings(
      env({ ...full, PORTAL_INTERNAL_URL: 'http://portal-auth:3100/' }),
    );
    expect(settings.internalUrl).toBe('http://portal-auth:3100');
    expect(settings.issuer).toBe('https://portal.example.test');
  });

  it('weist eine ungültige Adresse ab', () => {
    expect(() =>
      readSsoSettings(env({ ...full, PORTAL_ISSUER: 'kein-url' })),
    ).toThrow(/PORTAL_ISSUER/);
    expect(() =>
      readSsoSettings(env({ ...full, PORTAL_ISSUER: 'ftp://portal.example.test' })),
    ).toThrow(/http/);
  });

  it('baut die Logout-Adresse mit client_id und post_logout_redirect_uri', () => {
    const url = new URL(portalLogoutUrl(readSsoSettings(env(full))));
    expect(url.origin + url.pathname).toBe('https://portal.example.test/oauth/logout');
    expect(url.searchParams.get('client_id')).toBe('meine-verwaltung');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(
      'https://verwaltung.example.test/',
    );
  });
});

describe('assertAllowedReturnPath', () => {
  it('lässt Pfade innerhalb der Verwaltung zu', () => {
    expect(assertAllowedReturnPath('/invoices/abc?x=1')).toBe('/invoices/abc?x=1');
    expect(assertAllowedReturnPath('/')).toBe('/');
  });

  it.each([
    ['', '/'],
    [undefined, '/'],
    ['https://boese.example.test/', '/'],
    ['//boese.example.test', '/'],
    ['/\\boese.example.test', '/'],
    ['invoices', '/'],
    ['/a\nb', '/'],
    ['/login', '/'],
    ['/api/auth/sso/start', '/'],
    ['/' + 'a'.repeat(600), '/'],
  ])('ersetzt %p durch /', (input, expected) => {
    expect(assertAllowedReturnPath(input)).toBe(expected);
  });
});

describe('stepUpFresh', () => {
  const now = new Date('2026-11-16T12:00:00Z');
  it('gilt fünf Minuten', () => {
    expect(stepUpFresh(new Date(now.getTime() - 1000), now)).toBe(true);
    expect(stepUpFresh(new Date(now.getTime() - STEP_UP_VALID_MS + 1), now)).toBe(true);
    expect(stepUpFresh(new Date(now.getTime() - STEP_UP_VALID_MS), now)).toBe(false);
  });
  it('gilt nicht ohne Zeitpunkt und nicht aus der Zukunft', () => {
    expect(stepUpFresh(null, now)).toBe(false);
    expect(stepUpFresh(new Date(now.getTime() + 1000), now)).toBe(false);
  });
});
