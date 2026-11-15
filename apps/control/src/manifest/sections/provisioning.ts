import {
  sectionAsObject,
  optionalTextField,
  textField,
  textMap,
  type ErrorList,
} from '../validation';

/**
 * Wo die Sicherungswerkzeuge die Daten einer Instanz finden (Abschnitt
 * `provisioning.backup`, OPTIONAL). Ohne den Abschnitt gibt es für die
 * Instanzen dieser Software keinen Sicherungsplan.
 */
export interface BackupManifest {
  /** Compose-Dienst der Datenbank (Std "db"). */
  dbServiceName: string;
  dbName: string;
  dbUser: string;
  /** Compose-Dienst, der das Upload-Volume einhängt; null = keine Uploads. */
  uploadsService: string | null;
  /** Pfad des Upload-Verzeichnisses im Dienst; null = keine Uploads. */
  uploadsPath: string | null;
  /**
   * Muster des Compose-Projektnamens. Platzhalter: {subdomain} und
   * {applicationId} (Coolify-UUID der Anwendung). Std "{subdomain}".
   */
  composeProjectPattern: string;
}

/** Platzhalter des Compose-Projekt-Musters. */
export const COMPOSE_PROJECT_PLACEHOLDERS = ['subdomain', 'applicationId'] as const;

/** Setzt das Compose-Projekt-Muster ein; null, wenn ein Platzhalter keinen Wert hat. */
export function composeProjectFor(
  pattern: string,
  values: { subdomain: string; applicationId: string | null },
): string | null {
  let missing = false;
  const text = pattern.replace(/\{([A-Za-z]+)\}/g, (whole, name: string) => {
    if (name === 'subdomain') return values.subdomain;
    if (name === 'applicationId') {
      if (values.applicationId === null) missing = true;
      return values.applicationId ?? '';
    }
    return whole;
  });
  return missing ? null : text;
}

export const BACKUP_PRESET = {
  dbServiceName: 'db',
  composeProjectPattern: '{subdomain}',
} as const;

function checkBackup(raw: unknown, error: ErrorList): BackupManifest | null {
  if (raw === undefined || raw === null) return null;
  const where = 'provisioning.backup';
  const o = sectionAsObject(raw, where, error);
  const identifier = /^[A-Za-z_][A-Za-z0-9_.-]{0,62}$/;
  const dbServiceName = textField(o, 'dbServiceName', where, BACKUP_PRESET.dbServiceName, error, {
    pattern: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/,
    patternHint: 'nur Buchstaben, Ziffern, Punkt, Binde- und Unterstrich',
  });
  const dbName = textField(o, 'dbName', where, '', error, {
    pattern: identifier,
    patternHint: 'nur Buchstaben, Ziffern, Punkt, Binde- und Unterstrich',
  });
  const dbUser = textField(o, 'dbUser', where, '', error, {
    pattern: identifier,
    patternHint: 'nur Buchstaben, Ziffern, Punkt, Binde- und Unterstrich',
  });
  if (dbName === '') error.push(`${where}.dbName: ist Pflicht`);
  if (dbUser === '') error.push(`${where}.dbUser: ist Pflicht`);
  const uploadsService = optionalTextField(o, 'uploadsService', where, error);
  const uploadsPath = optionalTextField(o, 'uploadsPath', where, error);
  if ((uploadsService === null) !== (uploadsPath === null)) {
    error.push(`${where}: uploadsService und uploadsPath gehören zusammen (beide oder keines)`);
  }
  if (uploadsPath !== null && (!uploadsPath.startsWith('/') || uploadsPath.includes('..'))) {
    error.push(`${where}.uploadsPath: muss ein absoluter Pfad ohne ".." sein`);
  }
  if (uploadsService !== null && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(uploadsService)) {
    error.push(`${where}.uploadsService: nur Buchstaben, Ziffern, Punkt, Binde- und Unterstrich`);
  }
  const composeProjectPattern = textField(
    o,
    'composeProjectPattern',
    where,
    BACKUP_PRESET.composeProjectPattern,
    error,
    { notEmpty: true },
  );
  for (const match of composeProjectPattern.matchAll(/\{([^{}]*)\}/g)) {
    if (!(COMPOSE_PROJECT_PLACEHOLDERS as readonly string[]).includes(match[1])) {
      error.push(
        `${where}.composeProjectPattern: unbekannter Platzhalter {${match[1]}} ` +
          `(erlaubt: ${COMPOSE_PROJECT_PLACEHOLDERS.map((p) => `{${p}}`).join(', ')})`,
      );
    }
  }
  if (!/\{(subdomain|applicationId)\}/.test(composeProjectPattern)) {
    error.push(`${where}.composeProjectPattern: muss {subdomain} oder {applicationId} enthalten`);
  }
  return {
    dbServiceName,
    dbName,
    dbUser,
    uploadsService,
    uploadsPath,
    composeProjectPattern,
  };
}

export interface ProvisioningManifest {
  /** Basisdomain der Instanzen, z. B. "example.com". */
  instanceDomainBase: string;
  /** Subdomain-Muster; {slug} wird durch den Instanz-Kurznamen ersetzt. */
  subdomainPattern: string;
  /**
   * Quelle der Compose-Definition: eine Git-URL (wirkt wie `repository`) oder
   * ein Pfad zur Compose-Datei im Repository (wirkt wie `composePath`).
   * `repository` und `composePath` haben Vorrang, wenn beides angegeben ist.
   */
  composeSource: string;
  /**
   * Umgebungsvariablen-Vorlagen, die jeder Instanz mitgegeben werden.
   * Platzhalter: {subdomain}, {domain} (voller Hostname), {setupToken},
   * {metricsToken}. SETUP_TOKEN und METRICS_TOKEN setzt die Verwaltung selbst.
   */
  instanceEnv: Record<string, string>;
  /** Instanz-Vertrag: Pfad der Gesundheitsprüfung (Pflicht-Endpunkt). */
  healthPath: string;
  /**
   * Pfad des Kennzahlen-Endpunkts der Instanzen (Instanz-Vertrag, geschützt
   * durch METRICS_TOKEN). OPTIONAL: null = die Software bietet keinen, der
   * Kennzahlenabruf überspringt ihre Instanzen ohne Fehler und ohne Alarm.
   */
  metricsPath: string | null;
  /** Namenspräfix der Coolify-Anwendungen: `<instancePrefix>-<subdomain>`. */
  instancePrefix: string;
  /** Instanz-Vertrag: Pfad, über den der Einladungslink die Einrichtung startet (SETUP_TOKEN). */
  setupPath: string;
  /** Instanz-Vertrag: Pfad der Einrichtungs-Auskunft; OPTIONAL (null = keine). */
  setupStatusPath: string | null;
  /** Git-URL der Instanz-Compose (Coolify-Quelle); leer = per Umgebung setzen. */
  repository: string;
  /** Pfad der Compose-Datei im Repository. */
  composePath: string;
  /**
   * Eigene Coolify-Anwendungen des Betriebs (nicht Kundeninstanzen), die der
   * Abgleich nicht als verwaist melden soll; null = nichts ausschließen.
   */
  ownApplications: string[];
  /** Optional: wo die Sicherung die Daten einer Instanz findet; null = kein Sicherungsplan. */
  backup: BackupManifest | null;
}

export const PROVISIONING_PRESET: ProvisioningManifest = {
  instanceDomainBase: 'example.com',
  subdomainPattern: '{slug}.{base}',
  composeSource: '',
  instanceEnv: {},
  healthPath: '/api/health',
  metricsPath: null,
  instancePrefix: 'instance',
  setupPath: '/api/setup/start',
  setupStatusPath: null,
  repository: '',
  composePath: '/docker-compose.coolify.yml',
  ownApplications: [],
  backup: null,
};

/** Platzhalter, die eine Umgebungsvorlage kennt. */
export const ENV_PLACEHOLDERS = ['subdomain', 'domain', 'setupToken', 'metricsToken'] as const;
export type EnvPlaceholder = (typeof ENV_PLACEHOLDERS)[number];

/** Diese beiden Variablen setzt die Verwaltung selbst (Instanz-Vertrag). */
export const RESERVED_ENV_NAMES = ['SETUP_TOKEN', 'METRICS_TOKEN'] as const;

/** Setzt die Platzhalter {subdomain}, {domain}, {setupToken}, {metricsToken} ein. */
export function fillEnvTemplate(
  template: string,
  values: Record<EnvPlaceholder, string>,
): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (whole, name: string) =>
    (ENV_PLACEHOLDERS as readonly string[]).includes(name) ? values[name as EnvPlaceholder] : whole,
  );
}

function checkEnvTemplates(env: Record<string, string>, error: ErrorList): void {
  for (const [name, template] of Object.entries(env)) {
    const where = `provisioning.instanceEnv.${name}`;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      error.push(`${where}: ungültiger Variablenname`);
    }
    if ((RESERVED_ENV_NAMES as readonly string[]).includes(name)) {
      error.push(`${where}: wird von der Verwaltung gesetzt und darf hier nicht stehen`);
    }
    for (const match of template.matchAll(/\{([^{}]*)\}/g)) {
      if (!(ENV_PLACEHOLDERS as readonly string[]).includes(match[1])) {
        error.push(
          `${where}: unbekannter Platzhalter {${match[1]}} ` +
            `(erlaubt: ${ENV_PLACEHOLDERS.map((p) => `{${p}}`).join(', ')})`,
        );
      }
    }
  }
}

export function checkProvisioning(raw: unknown, error: ErrorList): ProvisioningManifest {
  const o = sectionAsObject(raw, 'provisioning', error);
  const pattern = textField(o, 'subdomainPattern', 'provisioning', PROVISIONING_PRESET.subdomainPattern, error, {
    notEmpty: true,
  });
  if (!pattern.includes('{slug}')) {
    error.push('provisioning.subdomainPattern: muss den Platzhalter {slug} enthalten');
  }
  for (const match of pattern.matchAll(/\{([^{}]*)\}/g)) {
    if (match[1] !== 'slug' && match[1] !== 'base') {
      error.push(`provisioning.subdomainPattern: unbekannter Platzhalter {${match[1]}} (erlaubt: {slug}, {base})`);
    }
  }
  const metricsPath = optionalTextField(o, 'metricsPath', 'provisioning', error);
  if (metricsPath !== null && !metricsPath.startsWith('/')) {
    error.push('provisioning.metricsPath: muss mit "/" beginnen');
  }
  const path = (key: 'setupPath' | 'healthPath', preset: string): string => {
    const value = textField(o, key, 'provisioning', preset, error, { notEmpty: true });
    if (!value.startsWith('/')) {
      error.push(`provisioning.${key}: muss mit "/" beginnen`);
      return preset;
    }
    return value;
  };
  const setupStatusPath = optionalTextField(o, 'setupStatusPath', 'provisioning', error);
  if (setupStatusPath !== null && !setupStatusPath.startsWith('/')) {
    error.push('provisioning.setupStatusPath: muss mit "/" beginnen');
  }
  const instanceEnv = textMap(o['instanceEnv'], 'provisioning.instanceEnv', error);
  checkEnvTemplates(instanceEnv, error);
  const prefix = textField(o, 'instancePrefix', 'provisioning', PROVISIONING_PRESET.instancePrefix, error, {
    pattern: /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    patternHint: 'nur Kleinbuchstaben, Ziffern und Bindestriche',
  });
  const own: string[] = [];
  const rawOwn = o['ownApplications'];
  if (rawOwn !== undefined && rawOwn !== null) {
    if (!Array.isArray(rawOwn) || rawOwn.some((n) => typeof n !== 'string')) {
      error.push('provisioning.ownApplications: muss eine Liste von Texten sein');
    } else {
      own.push(...(rawOwn as string[]).map((n) => n.trim()).filter((n) => n !== ''));
    }
  }
  return {
    instanceDomainBase: textField(o, 'instanceDomainBase', 'provisioning', PROVISIONING_PRESET.instanceDomainBase, error, {
      pattern: /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i,
      patternHint: 'keine gültige Domain (z. B. "example.com")',
    }),
    subdomainPattern: pattern,
    composeSource: textField(o, 'composeSource', 'provisioning', PROVISIONING_PRESET.composeSource, error),
    instanceEnv,
    healthPath: path('healthPath', PROVISIONING_PRESET.healthPath),
    metricsPath,
    instancePrefix: prefix,
    setupPath: path('setupPath', PROVISIONING_PRESET.setupPath),
    setupStatusPath,
    repository: textField(o, 'repository', 'provisioning', PROVISIONING_PRESET.repository, error),
    composePath: textField(o, 'composePath', 'provisioning', PROVISIONING_PRESET.composePath, error, {
      notEmpty: true,
    }),
    ownApplications: own,
    backup: checkBackup(o['backup'], error),
  };
}
