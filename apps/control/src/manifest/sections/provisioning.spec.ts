import { checkProvisioning, fillEnvTemplate, PROVISIONING_PRESET } from './provisioning';

function run(raw: unknown) {
  const error: string[] = [];
  const value = checkProvisioning(raw, error);
  return { value, error };
}

describe('Manifest-Abschnitt provisioning', () => {
  it('Vorgaben sind gültig; metrics und setup-status sind ohne Angabe NICHT deklariert', () => {
    const { value, error } = run({});
    expect(error).toEqual([]);
    expect(value.metricsPath).toBeNull();
    expect(value.setupStatusPath).toBeNull();
    expect(value.healthPath).toBe(PROVISIONING_PRESET.healthPath);
  });

  it('liest die Instanz-Vertragspfade', () => {
    const { value, error } = run({
      healthPath: '/gesund',
      metricsPath: '/zahlen',
      setupStatusPath: '/setup/stand',
    });
    expect(error).toEqual([]);
    expect(value).toMatchObject({ healthPath: '/gesund', metricsPath: '/zahlen', setupStatusPath: '/setup/stand' });
  });

  it('verlangt "/" am Anfang jedes Pfads', () => {
    const text = run({ healthPath: 'gesund', setupStatusPath: 'stand' }).error.join('\n');
    expect(text).toContain('provisioning.healthPath');
    expect(text).toContain('provisioning.setupStatusPath');
  });

  it('lehnt unbekannte Platzhalter im Hostmuster und in Env-Vorlagen ab', () => {
    expect(run({ subdomainPattern: '{slug}.{foo}' }).error.join()).toContain('{foo}');
    const text = run({ instanceEnv: { A: '{subdomian}', B: '{subdomain}' } }).error.join('\n');
    expect(text).toContain('provisioning.instanceEnv.A');
    expect(text).toContain('{subdomian}');
    expect(text).not.toContain('instanceEnv.B');
  });

  it('lässt SETUP_TOKEN und METRICS_TOKEN nicht per Vorlage setzen', () => {
    const text = run({ instanceEnv: { SETUP_TOKEN: '{setupToken}', METRICS_TOKEN: 'x' } }).error.join('\n');
    expect(text).toContain('instanceEnv.SETUP_TOKEN');
    expect(text).toContain('instanceEnv.METRICS_TOKEN');
  });

  it('fillEnvTemplate setzt alle vier Platzhalter ein', () => {
    expect(
      fillEnvTemplate('{subdomain}|{domain}|{setupToken}|{metricsToken}|{x}', {
        subdomain: 's',
        domain: 'd.test',
        setupToken: 'st',
        metricsToken: 'mt',
      }),
    ).toBe('s|d.test|st|mt|{x}');
  });
});
