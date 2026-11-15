import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ManifestService } from '../manifest/manifest.service';

/**
 * Alles, was die Coolify-Anbindung aus der Umgebung braucht — an EINER Stelle,
 * damit „ist das konfiguriert?" eine einzige Antwort hat.
 *
 * Rangfolge je Wert: Umgebungsvariable, dann Manifest (Abschnitt
 * `provisioning`), dann neutrale Vorgabe. Projekt, Server und Deploy-Key
 * gehören zur Coolify-Installation des Betreibers und haben deshalb KEINE
 * Vorgabe; ohne sie scheitert das Anlegen einer Instanz sichtbar in Coolify.
 */
/**
 * Der INSTANZ-VERTRAG: alles, was die Verwaltung über die Adressierung und
 * die Schnittstelle ihrer Instanzen wissen muss. Unabhängig vom Coolify-Token
 * lesbar, weil auch rein lesende Ansichten (Einladungslink, Kennzahlen) ihn
 * brauchen.
 */
export interface InstanceContract {
  baseDomain: string;
  /** Muster des Hostnamens; `{slug}` = Subdomain, `{base}` = Basisdomain. */
  subdomainPattern: string;
  /** Pfad der Gesundheitsprüfung (Pflicht-Endpunkt des Instanz-Vertrags). */
  healthPath: string;
  /** Namenspräfix der Coolify-Anwendungen: `<präfix>-<subdomain>`. */
  instancePrefix: string;
  /** Pfad des Einladungslinks (Token als Query, SETUP_TOKEN). */
  setupPath: string;
  /** Pfad der Einrichtungs-Auskunft; `null` = die Software bietet keine (optional). */
  setupStatusPath: string | null;
  /**
   * Pfad des Kennzahlen-Endpunkts (METRICS_TOKEN); `null` = die Software
   * bietet keine — der Kennzahlenabruf überspringt ihre Instanzen sauber.
   */
  metricsPath: string | null;
}

/** Der Hostname einer Instanz nach dem Muster des Manifests. */
export function instanceHost(
  contract: Pick<InstanceContract, 'baseDomain' | 'subdomainPattern'>,
  slug: string,
): string {
  return contract.subdomainPattern
    .split('{slug}')
    .join(slug)
    .split('{base}')
    .join(contract.baseDomain);
}

export interface CoolifyConfig extends InstanceContract {
  apiUrl: string;
  token: string;
  projectUuid: string;
  serverUuid: string;
  deployKeyUuid: string;
  repository: string;
  branch: string;
  composePath: string;
  environmentName: string;
  /**
   * ANWENDUNGEN DES EIGENEN BETRIEBS, die der Abgleich nicht als verwaist
   * melden soll.
   *
   * WOZU: `GET /applications` liefert ALLES, was in Coolify liegt — auch die
   * Verwaltung selbst, die Webseite und die Kunden-App. Sie heissen nach
   * demselben Schema wie eine Kundeninstanz (`<präfix>-<subdomain>`), und der
   * Abgleich konnte sie deshalb nicht unterscheiden: vier dauerhafte
   * Falschmeldungen unter „Heute".
   *
   * WARUM DAS DIE PRUEFUNG NICHT ENTWERTET: Vier Befunde, die immer dastehen,
   * machen aus der Liste eine, die niemand mehr liest — und dann rutscht der
   * eine echte Fund durch, fuer den es sie gibt: eine Kundeninstanz, die in
   * Coolify laeuft und die niemand ins CRM eingetragen hat.
   *
   * WARUM ES KEINE KUNDENINSTANZ VERDECKEN KANN: `InstanceService.isTaken`
   * prueft eine gewuenschte Subdomain unter anderem gegen
   * `<präfix>-<subdomain>` in Coolify. Die Subdomains dieser Liste sind damit
   * strukturell vergeben — es kann sie gar keine Kundeninstanz geben. Das ist
   * kein Zufall, auf den man hofft, sondern eine Sperre, die schon da war.
   */
  ownApplications: readonly string[];
  /**
   * Die Versanddaten, die JEDE neue Kundeninstanz mitbekommt — oder `null`,
   * wenn sie fehlen. Dann wird keine Instanz angelegt.
   */
  instanceSmtp: InstanceSmtp | null;
}

/**
 * Der GETEILTE Postausgang aller Kundeninstanzen.
 *
 * Das Provisionierungsskript gab ihn jeder Instanz aus einer zentralen
 * SMTP-Datei mit („zentraler Versandserver für ALLE"). Beim Übertragen in die Verwaltung
 * fiel das weg, und die Kunden-Compose verlangt `SMTP_HOST` mit
 * `${SMTP_HOST:?…}`. Coolify machte daraus DIE MELDUNG als Wert — gemessen am
 * 11.09.2026 an einer Kundeninstanz: `SMTP_HOST` war ein deutscher Satz,
 * Benutzer und Passwort leer. Die Instanz hätte weder Einladungen noch
 * Passwort-Links verschickt.
 */
export interface InstanceSmtp {
  host: string;
  port: string;
  user: string;
  pass: string;
  /**
   * PFLICHT, nicht nur der Host: Ohne ihn greift die Vorgabe der
   * Kunden-Compose (`noreply@example.com`), und der Postausgang bindet den
   * Absender an das Konto — er wiese ihn mit 553 ab (derselbe Fehler wie am
   * 07.09.2026 beim Versand der Verwaltung).
   */
  from: string;
}

export const PRESETS = {
  apiUrl: 'http://localhost:8000/api/v1',
  // Projekt, Server und Deploy-Key gehören zur Coolify-Installation des
  // Betreibers: keine Vorgabe (leer = nicht gesetzt).
  projectUuid: '',
  serverUuid: '',
  deployKeyUuid: '',
  repository: '',
  branch: 'main',
  composePath: '/docker-compose.coolify.yml',
  environmentName: 'production',
  baseDomain: 'example.com',
  subdomainPattern: '{slug}.{base}',
  healthPath: '/api/health',
  instancePrefix: 'instance',
  setupPath: '/api/setup/start',
  setupStatusPath: '/api/setup/status',
  metricsPath: '/api/intern/kennzahlen',
  /**
   * Eigene Anwendungen des Betriebs (Verwaltung, Webseite, Demo ...), die der
   * Abgleich nicht als verwaist melden soll. Neutral: leer. Der Betreiber
   * trägt sie im Manifest (`provisioning.ownApplications`) oder über
   * `CONTROL_COOLIFY_OWN_APPLICATIONS` ein — mit dem Präfix der Instanzen,
   * sonst wäre der Eintrag wirkungslos (der Abgleich betrachtet nur Namen
   * dieses Schemas).
   */
  ownApplications: [] as readonly string[],
} as const;

/** Der Instanz-Vertrag ohne jede Umgebung: nur die neutralen Vorgaben. */
export const CONTRACT_PRESET: InstanceContract = {
  baseDomain: PRESETS.baseDomain,
  subdomainPattern: PRESETS.subdomainPattern,
  healthPath: PRESETS.healthPath,
  instancePrefix: PRESETS.instancePrefix,
  setupPath: PRESETS.setupPath,
  setupStatusPath: PRESETS.setupStatusPath,
  metricsPath: PRESETS.metricsPath,
};

@Injectable()
export class CoolifyConfigService {
  private readonly logger = new Logger(CoolifyConfigService.name);

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly manifestService?: ManifestService,
  ) {}

  /** Der Manifest-Abschnitt `provisioning` — ohne ManifestService (Tests) leer. */
  private get manifest() {
    return this.manifestService?.provisioning;
  }

  /**
   * Die Konfiguration — oder `null`, wenn kein API-Token vorliegt.
   *
   * OHNE TOKEN KEINE ANBINDUNG, und zwar sichtbar: Der Instanz-Bereich
   * antwortet dann mit einem fachlichen Fehler statt mit einer stillen
   * Wirkungslosigkeit. Dasselbe Muster wie `CONTROL_INQUIRY_KEY` —
   * eine vergessene Variable soll auffallen, nicht durchrutschen.
   */
  /**
   * Die Ausschlussliste aus der Umgebung — oder die Vorgabe.
   *
   * EINE GESETZTE, ABER LEERE VARIABLE HEISST „NICHTS AUSSCHLIESSEN". Wer
   * `CONTROL_COOLIFY_OWN_APPLICATIONS=` schreibt, will alles sehen; auf die
   * Vorgabe zurueckzufallen waere das Gegenteil dessen, was dasteht. Deshalb
   * `!== undefined` und nicht `|| VORGABEN`.
   */
  private ownApplications(): readonly string[] {
    const raw = this.config.get<string>('CONTROL_COOLIFY_OWN_APPLICATIONS');
    if (raw === undefined) {
      return this.manifest?.ownApplications ?? PRESETS.ownApplications;
    }
    return raw
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');
  }

  /**
   * =====================================================================
   * DER PRÄFIX `COOLIFY_` GEHÖRT COOLIFY, NICHT UNS
   * =====================================================================
   *
   * Coolify spritzt in JEDEN Container, den es verwaltet, eigene Variablen
   * mit genau diesem Präfix: `COOLIFY_BRANCH`, `COOLIFY_URL`,
   * `COOLIFY_FQDN`, `COOLIFY_CONTAINER_NAME`, `COOLIFY_RESOURCE_UUID`.
   * Unsere Konfiguration hiess genauso — und las damit fremde Werte.
   *
   * GEMESSEN am 08.09.2026 im laufenden Container:
   *
   *     COOLIFY_BRANCH = '"main"'
   *
   * MIT Anführungszeichen IM Wert. Daraus wurde `git_branch: "\"main\""`,
   * und Coolify wies die eigene Anfrage ab: „The git branch contains
   * invalid characters." Das Anlegen jeder Kundeninstanz scheiterte am
   * ersten Aufruf — ohne dass irgendein Wert falsch gesetzt gewesen wäre.
   *
   * DESHALB `CONTROL_COOLIFY_*`, wie alles andere in dieser Anwendung auch
   * (`CONTROL_APP_URL`, `CONTROL_CONFIG_KEY`, …). Der alte Name bleibt als
   * Rückfallebene, damit eine bestehende Installation nicht stehenbleibt —
   * aber er wird gemeldet, und er wird ENTWERTET, wo Coolify ihn selbst
   * belegt.
   */
  private value(name: string, coolifyOccupied = false): string | undefined {
    const own = sanitize(this.config.get<string>(`CONTROL_COOLIFY_${name}`));
    if (own !== undefined) return own;
    if (coolifyOccupied) {
      // NICHT auf den alten Namen zurückfallen: Was dort steht, hat Coolify
      // hineingeschrieben, nicht die Betreiberin. Ein fremder Wert ist
      // schlechter als gar keiner — die Vorgabe greift.
      return undefined;
    }
    const old = sanitize(this.config.get<string>(`COOLIFY_${name}`));
    if (old !== undefined) {
      this.logger.warn(
        `COOLIFY_${name} ist gesetzt. Dieser Präfix gehört Coolify selbst; ` +
          `bitte auf CONTROL_COOLIFY_${name} umstellen.`,
      );
    }
    return old;
  }

  /**
   * Die Compose-Quelle aus dem Manifest: `repository`, sonst `composeSource`,
   * sofern diese eine Git-URL ist. Ist `composeSource` ein Pfad, gilt er als
   * Pfad der Compose-Datei im Repository (`composePath`).
   */
  private manifestRepository(): string | undefined {
    const source = sanitize(this.manifest?.composeSource);
    return sanitize(this.manifest?.repository) ?? (isPath(source) ? undefined : source);
  }

  /** Ist `composeSource` ein Pfad (statt einer Git-URL), ist es der Pfad der Compose-Datei. */
  private manifestComposePath(): string | undefined {
    const source = sanitize(this.manifest?.composeSource);
    return isPath(source) ? source : undefined;
  }

  /** Die Umgebungsvorlagen je Instanz aus dem Manifest (leer ohne Manifest). */
  instanceEnvTemplates(): Readonly<Record<string, string>> {
    return this.manifest?.instanceEnv ?? {};
  }

  /**
   * Der Instanz-Vertrag: Umgebungsvariable, dann Manifest, dann Vorgabe.
   * Gilt auch ohne Coolify-Token.
   */
  contract(): InstanceContract {
    const env = (name: string) => sanitize(this.config.get<string>(name));
    return {
      baseDomain:
        env('CONTROL_INSTANCE_BASE_DOMAIN') ??
        sanitize(this.manifest?.instanceDomainBase) ??
        PRESETS.baseDomain,
      subdomainPattern:
        sanitize(this.manifest?.subdomainPattern) ?? PRESETS.subdomainPattern,
      healthPath: sanitize(this.manifest?.healthPath) ?? PRESETS.healthPath,
      instancePrefix:
        env('CONTROL_INSTANCE_PREFIX') ??
        sanitize(this.manifest?.instancePrefix) ??
        PRESETS.instancePrefix,
      setupPath:
        env('CONTROL_INSTANCE_SETUP_PATH') ??
        sanitize(this.manifest?.setupPath) ??
        PRESETS.setupPath,
      // Ohne Manifest (Prüfläufe) gilt die Vorgabe des Vertrags. MIT Manifest
      // heisst „nicht angegeben": die Software bietet den optionalen Endpunkt
      // nicht, und seine Abfrage entfällt.
      setupStatusPath:
        env('CONTROL_INSTANCE_SETUP_STATUS_PATH') ??
        (this.manifest === undefined
          ? PRESETS.setupStatusPath
          : (sanitize(this.manifest.setupStatusPath ?? undefined) ?? null)),
      metricsPath:
        env('CONTROL_INSTANCE_METRICS_PATH') ??
        (this.manifest === undefined
          ? PRESETS.metricsPath
          : (sanitize(this.manifest.metricsPath ?? undefined) ?? null)),
    };
  }

  read(): CoolifyConfig | null {
    const token = this.value('TOKEN');
    if (!token) {
      this.logger.warn(
        'COOLIFY_TOKEN ist nicht gesetzt — die Instanzverwaltung kann weder ' +
          'anlegen noch archivieren noch abgleichen. Lesende Ansichten und ' +
          'die Kennzahlen-Abfrage arbeiten unverändert weiter.',
      );
      return null;
    }
    // `true` = Coolify belegt diesen Namen selbst, der alte gilt nicht mehr.
    const branch = this.value('BRANCH', true) ?? PRESETS.branch;
    if (!isSimpleValue(branch)) {
      this.logger.error(
        `CONTROL_COOLIFY_BRANCH ist kein gültiger Branchname: ${branch}. ` +
          'Die Instanzverwaltung bleibt aus, statt Coolify eine Anfrage zu ' +
          'schicken, die es ablehnt.',
      );
      return null;
    }

    // DIE COOLIFY-FALLE, IN EINER PRUEFUNG FESTGEHALTEN: Coolify legt fuer
    // jede in der Compose-Datei erwaehnte Variable einen Eintrag an und nimmt
    // bei `${VAR:?Meldung}` DIE MELDUNG als Wert. In der Verwaltung stand so
    // schon einmal ein ganzer Satz als Datenbankpasswort (06.09.2026). Eine
    // API-Adresse, die kein `http` ist, ist genau dieser Fall — und sie soll
    // hier auffallen, nicht beim ersten Kunden.
    const apiUrl = this.value('API_URL') ?? PRESETS.apiUrl;
    if (!/^https?:\/\//.test(apiUrl)) {
      this.logger.error(
        `CONTROL_COOLIFY_API_URL ist keine Adresse: ${apiUrl}. Die ` +
          'Instanzverwaltung bleibt aus.',
      );
      return null;
    }

    const repository = this.value('REPO') ?? this.manifestRepository();
    const missing = (
      [
        ['PROJECT_UUID', this.value('PROJECT_UUID')],
        ['SERVER_UUID', this.value('SERVER_UUID')],
        ['DEPLOY_KEY_UUID', this.value('DEPLOY_KEY_UUID')],
        ['REPO', repository],
      ] as const
    )
      .filter(([, value]) => value === undefined)
      .map(([name]) => `CONTROL_COOLIFY_${name}`);
    if (missing.length > 0) {
      this.logger.warn(
        `Nicht gesetzt: ${missing.join(', ')}. Ohne diese Werte lehnt Coolify ` +
          'das Anlegen einer Instanz ab.',
      );
    }

    return {
      token,
      apiUrl,
      projectUuid: this.value('PROJECT_UUID') ?? PRESETS.projectUuid,
      serverUuid: this.value('SERVER_UUID') ?? PRESETS.serverUuid,
      deployKeyUuid: this.value('DEPLOY_KEY_UUID') ?? PRESETS.deployKeyUuid,
      repository: this.value('REPO') ?? this.manifestRepository() ?? PRESETS.repository,
      branch,
      composePath:
        this.value('COMPOSE') ??
        this.manifestComposePath() ??
        sanitize(this.manifest?.composePath) ??
        PRESETS.composePath,
      environmentName: this.value('UMGEBUNG') ?? PRESETS.environmentName,
      ...this.contract(),
      ownApplications: this.ownApplications(),
      instanceSmtp: this.instanceSmtp(),
    };
  }

  /**
   * `CONTROL_INSTANCE_SMTP_*` — im EIGENEN Namensraum, nicht `SMTP_*`.
   *
   * `SMTP_*` sind die Versanddaten DIESER Verwaltung. Die der Kundeninstanzen
   * sind heute dieselben, aber es sind zwei Rollen: Wer den Postausgang der
   * Verwaltung umstellt, soll nicht nebenbei den aller Kunden umstellen.
   *
   * `null`, sobald Host ODER Absender fehlt — dann wird keine Instanz
   * angelegt. Eine stumme Instanz ist schlechter als keine.
   */
  private instanceSmtp(): InstanceSmtp | null {
    const read = (name: string) =>
      sanitize(this.config.get<string>(`CONTROL_INSTANCE_SMTP_${name}`));
    const host = read('HOST');
    const from = read('FROM');
    if (host === undefined || from === undefined) return null;
    return {
      host,
      port: read('PORT') ?? '587',
      user: read('USER') ?? '',
      pass: read('PASS') ?? '',
      from,
    };
  }
}

/** Ein Dateipfad (`/docker-compose.yml`, `./x.yaml`) statt einer Git-URL. */
function isPath(value: string | undefined): value is string {
  return (
    value !== undefined &&
    !value.includes('://') &&
    !value.includes('@') &&
    (value.startsWith('/') || value.startsWith('./') || /\.ya?ml$/i.test(value))
  );
}

/**
 * Trimmt und streift EIN Paar umschliessender Anführungszeichen ab.
 *
 * Das ist die zweite Verteidigungslinie hinter dem eigenen Präfix: Coolify
 * schreibt seine Werte gequotet in die Umgebung (`COOLIFY_BRANCH='"main"'`,
 * gemessen am 08.09.2026). Sollte je ein weiterer Name kollidieren oder eine
 * Betreiberin die Anführungszeichen selbst mit eintragen, kommt hier trotzdem
 * der gemeinte Wert heraus.
 *
 * Leer heisst `undefined` und nicht `''` — dann greift die Vorgabe, wie zuvor
 * beim `||`.
 */
export function sanitize(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value[value.length - 1] === first) {
      value = value.slice(1, -1).trim();
    }
  }
  return value === '' ? undefined : value;
}

/**
 * Taugt der Wert als Branch- oder Pfadangabe gegenüber Coolify?
 *
 * Bewusst eine ERLAUBNISLISTE. Coolify prüft dasselbe und antwortet sonst mit
 * `422 „The git branch contains invalid characters."` — nur eben erst beim
 * Anlegen einer Kundeninstanz, im ungünstigsten Augenblick. Hier fällt es
 * beim Start auf.
 */
export function isSimpleValue(value: string): boolean {
  return /^[A-Za-z0-9._\/-]+$/.test(value);
}
