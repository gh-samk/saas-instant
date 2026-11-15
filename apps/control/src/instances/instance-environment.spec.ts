import { buildInstanceEnvironment } from './instance-environment';

const SMTP = { host: 'mail.example.com', port: '587', user: 'u', pass: 'p', from: 'a@example.com' };
const SECRETS = { metricsToken: 'lese-token', setupToken: 'einmal-token' };
const BASE = { host: 'muster.example.com', subdomain: 'muster', smtp: SMTP, secrets: SECRETS, templates: {} };

describe('Umgebung einer neuen Instanz (Instanz-Vertrag)', () => {
  it('gibt der Software Domain, SETUP_TOKEN und METRICS_TOKEN mit', () => {
    const env = buildInstanceEnvironment(BASE);
    expect(env['APP_URL']).toBe('https://muster.example.com');
    expect(env['SETUP_TOKEN']).toBe('einmal-token');
    expect(env['METRICS_TOKEN']).toBe('lese-token');
  });

  it('setzt die Platzhalter der Manifest-Vorlagen ein', () => {
    const env = buildInstanceEnvironment({
      ...BASE,
      templates: {
        TENANT: '{subdomain}',
        PUBLIC_HOST: '{domain}',
        BOOTSTRAP: 'tok-{setupToken}',
        READ_KEY: '{metricsToken}',
        MIX: 'x-{subdomain}-{unbekannt}',
      },
    });
    expect(env['TENANT']).toBe('muster');
    expect(env['PUBLIC_HOST']).toBe('muster.example.com');
    expect(env['BOOTSTRAP']).toBe('tok-einmal-token');
    expect(env['READ_KEY']).toBe('lese-token');
    // Unbekannte Platzhalter bleiben stehen (das Manifest lehnt sie schon beim Laden ab).
    expect(env['MIX']).toBe('x-muster-{unbekannt}');
  });

  it('lässt eine Vorlage die Grundwerte ergänzen, aber nie die Token der Verwaltung ersetzen', () => {
    const env = buildInstanceEnvironment({
      ...BASE,
      templates: { NODE_ENV: 'staging', SETUP_TOKEN: 'falsch', METRICS_TOKEN: 'falsch' },
    });
    expect(env['NODE_ENV']).toBe('staging');
    expect(env['SETUP_TOKEN']).toBe('einmal-token');
    expect(env['METRICS_TOKEN']).toBe('lese-token');
  });

  it('erzeugt je Aufruf frische Geheimnisse', () => {
    const a = buildInstanceEnvironment(BASE);
    const b = buildInstanceEnvironment(BASE);
    expect(a['POSTGRES_PASSWORD']).not.toBe(b['POSTGRES_PASSWORD']);
  });

  it('wirft ohne Versanddaten, bevor irgendetwas angelegt würde', () => {
    expect(() => buildInstanceEnvironment({ ...BASE, smtp: null })).toThrow(/Versanddaten/);
  });
});
