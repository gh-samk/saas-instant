import {
  checkProvisioning,
  composeProjectFor,
  fillEnvTemplate,
  PROVISIONING_PRESET,
} from './provisioning';

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

describe('Manifest-Abschnitt provisioning.backup', () => {
  it('ist ohne Angabe nicht deklariert (kein Sicherungsplan)', () => {
    const { value, error } = run({});
    expect(error).toEqual([]);
    expect(value.backup).toBeNull();
  });

  it('übernimmt Vorgaben für Dienst und Compose-Projekt', () => {
    const { value, error } = run({ backup: { dbName: 'app', dbUser: 'app' } });
    expect(error).toEqual([]);
    expect(value.backup).toEqual({
      dbServiceName: 'db',
      dbName: 'app',
      dbUser: 'app',
      uploadsService: null,
      uploadsPath: null,
      composeProjectPattern: '{subdomain}',
    });
  });

  it('liest alle Felder', () => {
    const { value, error } = run({
      backup: {
        dbServiceName: 'postgres',
        dbName: 'crm',
        dbUser: 'crm_user',
        uploadsService: 'app',
        uploadsPath: '/app/uploads',
        composeProjectPattern: 'inst-{applicationId}',
      },
    });
    expect(error).toEqual([]);
    expect(value.backup).toMatchObject({ dbServiceName: 'postgres', uploadsPath: '/app/uploads' });
  });

  it('verlangt dbName und dbUser', () => {
    const text = run({ backup: {} }).error.join('\n');
    expect(text).toContain('provisioning.backup.dbName');
    expect(text).toContain('provisioning.backup.dbUser');
  });

  it('verlangt Upload-Dienst und -Pfad gemeinsam, absolut und ohne ".."', () => {
    expect(run({ backup: { dbName: 'a', dbUser: 'b', uploadsService: 'app' } }).error.join()).toContain(
      'gehören zusammen',
    );
    expect(
      run({ backup: { dbName: 'a', dbUser: 'b', uploadsService: 'app', uploadsPath: 'rel/pfad' } }).error.join(),
    ).toContain('uploadsPath');
    expect(
      run({ backup: { dbName: 'a', dbUser: 'b', uploadsService: 'app', uploadsPath: '/a/../b' } }).error.join(),
    ).toContain('uploadsPath');
  });

  it('lehnt Namen mit Leerzeichen/Shell-Zeichen und unbekannte Platzhalter ab', () => {
    expect(run({ backup: { dbName: 'a b', dbUser: 'x' } }).error.join()).toContain('dbName');
    expect(run({ backup: { dbName: 'a;rm', dbUser: 'x' } }).error.join()).toContain('dbName');
    expect(
      run({ backup: { dbName: 'a', dbUser: 'b', composeProjectPattern: '{slug}' } }).error.join(),
    ).toContain('{slug}');
    expect(
      run({ backup: { dbName: 'a', dbUser: 'b', composeProjectPattern: 'fest' } }).error.join(),
    ).toContain('muss {subdomain} oder {applicationId}');
  });

  it('composeProjectFor setzt ein oder meldet fehlende Anwendungs-ID', () => {
    expect(composeProjectFor('{subdomain}', { subdomain: 'x', applicationId: null })).toBe('x');
    expect(composeProjectFor('p-{applicationId}', { subdomain: 'x', applicationId: 'abc' })).toBe('p-abc');
    expect(composeProjectFor('p-{applicationId}', { subdomain: 'x', applicationId: null })).toBeNull();
  });
});
