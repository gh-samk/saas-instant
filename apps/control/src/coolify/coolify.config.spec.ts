import type { ConfigService } from '@nestjs/config';
import type { ManifestService } from '../manifest/manifest.service';
import {
  CoolifyConfigService,
  CONTRACT_PRESET,
  instanceHost,
  isSimpleValue,
  sanitize,
  PRESETS,
} from './coolify.config';

/**
 * ===========================================================================
 * DER BEFUND VOM 08.09.2026
 * ===========================================================================
 *
 * Das Anlegen jeder Kundeninstanz scheiterte am ersten Coolify-Aufruf:
 *
 *     422 — git_branch: The git branch contains invalid characters.
 *
 * Ursache war KEIN falsch gesetzter Wert, sondern eine Namenskollision:
 * Coolify spritzt in jeden Container, den es verwaltet, eigene Variablen mit
 * dem Praefix `COOLIFY_`. Im laufenden Container stand
 *
 *     COOLIFY_BRANCH = '"main"'
 *
 * mit Anfuehrungszeichen IM Wert. Unsere Konfiguration hiess genauso und las
 * damit Coolifys Wert statt ihres eigenen.
 */
function coolifyConfig(values: Record<string, string>): CoolifyConfigService {
  const config = {
    get: (name: string) => values[name],
  } as unknown as ConfigService;
  return new CoolifyConfigService(config);
}

describe('Der Praefix COOLIFY_ gehoert Coolify', () => {
  it('liest COOLIFY_BRANCH NICHT — auch wenn er dasteht', () => {
    const k = coolifyConfig({ COOLIFY_TOKEN: 't', COOLIFY_BRANCH: '"main"' });
    expect(k.read()?.branch).toBe(PRESETS.branch);
  });

  it('nimmt CONTROL_COOLIFY_BRANCH', () => {
    const k = coolifyConfig({ COOLIFY_TOKEN: 't', CONTROL_COOLIFY_BRANCH: 'pilot' });
    expect(k.read()?.branch).toBe('pilot');
  });

  it('laesst die Anbindung aus, wenn der eigene Branchname unbrauchbar ist', () => {
    // Lieber sichtbar aus als eine Anfrage, die Coolify mit 422 abweist —
    // dieselbe Haltung wie beim fehlenden Token.
    const k = coolifyConfig({ COOLIFY_TOKEN: 't', CONTROL_COOLIFY_BRANCH: 'main; rm -rf' });
    expect(k.read()).toBeNull();
  });

  it('bevorzugt den eigenen Namen vor dem alten', () => {
    const k = coolifyConfig({
      COOLIFY_TOKEN: 'alt',
      CONTROL_COOLIFY_TOKEN: 'neu',
      COOLIFY_PROJECT_UUID: 'alt-projekt',
      CONTROL_COOLIFY_PROJECT_UUID: 'neu-projekt',
    });
    expect(k.read()?.token).toBe('neu');
    expect(k.read()?.projectUuid).toBe('neu-projekt');
  });

  it('faellt fuer die uebrigen Namen auf den alten zurueck', () => {
    // Sonst stuende eine bestehende Installation nach dem Ausrollen still.
    const k = coolifyConfig({ COOLIFY_TOKEN: 't', COOLIFY_SERVER_UUID: 'server-alt' });
    expect(k.read()?.serverUuid).toBe('server-alt');
  });
});

describe('Die Coolify-Falle bleibt gefangen', () => {
  /**
   * Coolify legt fuer JEDE in der Compose-Datei erwaehnte Variable einen
   * Eintrag an — und nimmt bei `${VAR:?Meldung}` DIE MELDUNG als Wert. Am
   * 06.09.2026 stand so ein ganzer Satz als Datenbankpasswort in der
   * laufenden Verwaltung. Fuer die API-Adresse faellt derselbe Fall hier auf.
   */
  it('laesst die Anbindung aus, wenn die API-Adresse ein Satz ist', () => {
    const k = coolifyConfig({
      COOLIFY_TOKEN: 't',
      CONTROL_COOLIFY_API_URL: 'CONTROL_COOLIFY_API_URL muss gesetzt sein',
    });
    expect(k.read()).toBeNull();
  });

  it('nimmt eine echte Adresse an', () => {
    const k = coolifyConfig({
      COOLIFY_TOKEN: 't',
      CONTROL_COOLIFY_API_URL: 'http://host.docker.internal:8000/api/v1',
    });
    expect(k.read()?.apiUrl).toBe('http://host.docker.internal:8000/api/v1');
  });
});

describe('Werte werden entwertet, bevor sie hinausgehen', () => {
  it('streift genau EIN Paar Anfuehrungszeichen ab', () => {
    expect(sanitize('"main"')).toBe('main');
    expect(sanitize("'main'")).toBe('main');
    expect(sanitize('  main  ')).toBe('main');
  });

  it('laesst einzelne Anfuehrungszeichen stehen', () => {
    // `"main` ist kaputt und soll kaputt bleiben, damit die Pruefung anschlaegt.
    expect(sanitize('"main')).toBe('"main');
  });

  it('macht aus leer `undefined`, damit die Vorgabe greift', () => {
    expect(sanitize('')).toBeUndefined();
    expect(sanitize('   ')).toBeUndefined();
    expect(sanitize('""')).toBeUndefined();
    expect(sanitize(undefined)).toBeUndefined();
  });

  it('erkennt brauchbare von unbrauchbaren Werten', () => {
    expect(isSimpleValue('main')).toBe(true);
    expect(isSimpleValue('release/2026-09')).toBe(true);
    expect(isSimpleValue('v1.2.3')).toBe(true);
    expect(isSimpleValue('"main"')).toBe(false);
    expect(isSimpleValue('main branch')).toBe(false);
    expect(isSimpleValue('')).toBe(false);
  });
});

/**
 * Der geteilte Postausgang der Kundeninstanzen ([11.09.2026]). Ohne ihn hätte
 * Coolify `SMTP_HOST` aus der Pflichtform der Compose mit einem deutschen
 * Satz belegt.
 */
describe('Die Versanddaten für neue Instanzen', () => {
  const WITH = {
    COOLIFY_TOKEN: 't',
    CONTROL_INSTANCE_SMTP_HOST: 'mail.example.com',
    CONTROL_INSTANCE_SMTP_USER: 'noreply@example.com',
    CONTROL_INSTANCE_SMTP_PASS: 'geheim',
    CONTROL_INSTANCE_SMTP_FROM: 'Mein Produkt <noreply@example.com>',
  };

  it('liest sie aus dem eigenen Namensraum', () => {
    expect(coolifyConfig(WITH).read()?.instanceSmtp).toEqual({
      host: 'mail.example.com',
      port: '587',
      user: 'noreply@example.com',
      pass: 'geheim',
      from: 'Mein Produkt <noreply@example.com>',
    });
  });

  it('ist null ohne Host — dann wird keine Instanz angelegt', () => {
    const { CONTROL_INSTANCE_SMTP_HOST: _gone, ...without } = WITH;
    expect(coolifyConfig(without).read()?.instanceSmtp).toBeNull();
  });

  it('ist null ohne Absender — sonst griffe die Vorgabe noreply@example.com', () => {
    // Der Postausgang bindet den Absender an das Konto und wiese sie mit 553 ab.
    const { CONTROL_INSTANCE_SMTP_FROM: _gone, ...without } = WITH;
    expect(coolifyConfig(without).read()?.instanceSmtp).toBeNull();
  });

  it('nimmt NICHT die Versanddaten der Verwaltung selbst', () => {
    // Zwei Rollen: Wer den Postausgang der Verwaltung umstellt, soll nicht
    // nebenbei den aller Kunden umstellen.
    const k = coolifyConfig({ COOLIFY_TOKEN: 't', SMTP_HOST: 'x', SMTP_FROM: 'y' });
    expect(k.read()?.instanceSmtp).toBeNull();
  });
});

/**
 * Der Instanz-Vertrag: Adressierung und Schnittstelle der Instanzen kommen aus
 * Umgebung, Manifest oder neutraler Vorgabe — nie aus dem Quelltext eines
 * Betreibers. Er gilt auch ohne Coolify-Token.
 */
describe('Der Instanz-Vertrag', () => {
  function withManifest(values: Record<string, string>, provisioning: object) {
    const config = { get: (name: string) => values[name] } as unknown as ConfigService;
    const manifest = { provisioning } as unknown as ManifestService;
    return new CoolifyConfigService(config, manifest);
  }

  it('ist ohne jede Einstellung neutral', () => {
    expect(coolifyConfig({}).contract()).toEqual({
      baseDomain: 'example.com',
      subdomainPattern: '{slug}.{base}',
      healthPath: '/api/health',
      instancePrefix: 'instance',
      setupPath: '/api/setup/start',
      setupStatusPath: '/api/setup/status',
      metricsPath: '/api/intern/kennzahlen',
    });
  });

  it('liest das Manifest — auch ohne Coolify-Token', () => {
    const k = withManifest(
      {},
      {
        instanceDomainBase: 'kunden.example.com',
        subdomainPattern: 'app-{slug}.{base}',
        healthPath: '/gesund',
        instancePrefix: 'crm',
        setupPath: '/einrichtung/start',
        setupStatusPath: '/einrichtung/status',
        metricsPath: '/intern/zahlen',
      },
    );
    expect(k.read()).toBeNull();
    expect(k.contract()).toEqual({
      baseDomain: 'kunden.example.com',
      subdomainPattern: 'app-{slug}.{base}',
      healthPath: '/gesund',
      instancePrefix: 'crm',
      setupPath: '/einrichtung/start',
      setupStatusPath: '/einrichtung/status',
      metricsPath: '/intern/zahlen',
    });
  });

  it('kennt bei einer Software ohne metrics-/setup-status-Pfad keinen (optional, null)', () => {
    const k = withManifest({}, { metricsPath: null, setupStatusPath: null });
    expect(k.contract().metricsPath).toBeNull();
    expect(k.contract().setupStatusPath).toBeNull();
  });

  it('baut den Hostnamen nach dem Muster des Manifests', () => {
    const k = withManifest({}, { instanceDomainBase: 'kunden.example.com', subdomainPattern: 'app-{slug}.{base}' });
    expect(instanceHost(k.contract(), 'muster')).toBe('app-muster.kunden.example.com');
    expect(instanceHost(CONTRACT_PRESET, 'muster')).toBe('muster.example.com');
  });

  it('nimmt die Compose-Quelle: Git-URL als Repository, Pfad als Compose-Pfad', () => {
    const env = { CONTROL_COOLIFY_TOKEN: 't', CONTROL_COOLIFY_PROJECT_UUID: 'p', CONTROL_COOLIFY_SERVER_UUID: 's', CONTROL_COOLIFY_DEPLOY_KEY_UUID: 'k' };
    const url = withManifest(env, { composeSource: 'git@git.example.com:x/compose.git' }).read();
    expect(url?.repository).toBe('git@git.example.com:x/compose.git');
    const path = withManifest(env, { composeSource: '/deploy/compose.yml', repository: 'git@a:b.git' }).read();
    expect(path?.repository).toBe('git@a:b.git');
    expect(path?.composePath).toBe('/deploy/compose.yml');
    // `repository` hat Vorrang vor `composeSource`.
    expect(withManifest(env, { repository: 'git@a:b.git', composeSource: 'git@c:d.git' }).read()?.repository).toBe('git@a:b.git');
  });

  it('reicht die Umgebungsvorlagen des Manifests weiter', () => {
    expect(withManifest({}, { instanceEnv: { A: '{subdomain}' } }).instanceEnvTemplates()).toEqual({ A: '{subdomain}' });
    expect(coolifyConfig({}).instanceEnvTemplates()).toEqual({});
  });

  it('laesst die Umgebung das Manifest uebertrumpfen', () => {
    const k = withManifest(
      { CONTROL_INSTANCE_BASE_DOMAIN: 'env.example.com', CONTROL_INSTANCE_PREFIX: 'env' },
      { instanceDomainBase: 'manifest.example.com', instancePrefix: 'manifest' },
    );
    expect(k.contract().baseDomain).toBe('env.example.com');
    expect(k.contract().instancePrefix).toBe('env');
  });
});
