import { Logger } from '@nestjs/common';
import type { CoolifyConfig } from './coolify.config';
import type {
  ApplicationCreate,
  CoolifyApplication,
  CoolifyClient,
  CoolifyDeployment,
} from './coolify.types';

/** Wie lange ein einzelner Aufruf höchstens dauern darf. */
export const COOLIFY_TIMEOUT_MS = 30_000;

/**
 * HTTP-Client gegen die Coolify-API.
 *
 * SCHMAL UND VOLLSTÄNDIG AUFGEZÄHLT: Diese Klasse setzt genau die Methoden aus
 * `CoolifyClient` um und keine weitere. Ein `DELETE` gibt es genau einmal, in
 * `deleteApplication` (Löschung 90 Tage nach der Archivierung) —
 * `no-delete-path.spec.ts` prüft das über den Quelltext nach.
 *
 * NICHT GEGEN DIE ECHTE API BELEGT (Stand 31.08.2026): Die API ist nur über
 * `ssh -fN -L 8000:localhost:8000 <server>` erreichbar, der Tunnel lief bei der
 * Umsetzung nicht, und ein eigenes CRM-Token existiert noch nicht. Pfade und
 * Nutzlasten sind aus dem Referenzskript `reference/provision-tenant.py`
 * übernommen; geprüft ist diese Klasse ausschliesslich gegen die Attrappe
 * (`test-support/coolify-mock.ts`), die dieselben Antwortformen liefert.
 */
export class CoolifyHttpClient implements CoolifyClient {
  private readonly logger = new Logger(CoolifyHttpClient.name);

  constructor(private readonly coolifyConfig: CoolifyConfig) {}

  async version(): Promise<string> {
    const response = await this.call('GET', '/version');
    return typeof response === 'string' ? response : JSON.stringify(response);
  }

  async applications(): Promise<CoolifyApplication[]> {
    const raw = await this.call('GET', '/applications');
    const list = listFrom(raw);
    if (list === null) {
      // EINE UNERWARTETE FORM IST EIN AUSFALL, KEINE LEERE LISTE ([K2]).
      //
      // Eine frühere Fassung gab hier `[]` zurück. Damit galt jede belegte
      // Subdomain als FREI, sobald Coolify die Liste anders verpackt — und
      // genau das tut es je nach Version (`{"data":[…]}`). Ein Ausfall wird
      // zur Freigabe, und das Anlegen überschreibt ein bestehendes
      // Deployment: der stille Datenverlust, gegen den E3-10 geschrieben ist.
      //
      // Ein Wurf landet in `InstanceService.isTaken`, und der antwortet im
      // Zweifel „vergeben".
      throw new Error(
        'Coolify hat auf GET /applications keine lesbare Liste geliefert. ' +
          'Die Antwort wird als Ausfall behandelt, nicht als leere Liste.',
      );
    }
    return list.map((entry) => toApplication(entry as Record<string, unknown>));
  }

  async getApplication(uuid: string): Promise<CoolifyApplication | null> {
    const raw = await this.call('GET', `/applications/${uuid}`, undefined, [404]);
    if (raw === null) return null;
    return toApplication(raw as Record<string, unknown>);
  }

  async createApplication(data: ApplicationCreate): Promise<{ uuid: string }> {
    const raw = (await this.call('POST', '/applications/private-deploy-key', {
      project_uuid: this.coolifyConfig.projectUuid,
      server_uuid: this.coolifyConfig.serverUuid,
      environment_name: this.coolifyConfig.environmentName,
      private_key_uuid: this.coolifyConfig.deployKeyUuid,
      git_repository: this.coolifyConfig.repository,
      git_branch: this.coolifyConfig.branch,
      build_pack: 'dockercompose',
      docker_compose_location: this.coolifyConfig.composePath,
      name: data.name,
      // Erst Umgebung und Domäne setzen, dann ausrollen — sonst startet die
      // Anwendung einmal ohne Geheimnisse und ohne TLS.
      instant_deploy: false,
    })) as Record<string, unknown> | null;
    const uuid = raw?.['uuid'];
    if (typeof uuid !== 'string' || uuid.length === 0) {
      throw new Error('Coolify hat keine UUID für die neue Anwendung geliefert.');
    }
    return { uuid };
  }

  async setEnvironmentVariable(
    uuid: string,
    key: string,
    value: string,
  ): Promise<void> {
    // ANLEGEN — UND WENN ES SIE SCHON GIBT, ÄNDERN.
    //
    // Coolify legt per POST nur an (409, wenn es die Variable schon gibt) und
    // ändert per PATCH nur (404, wenn es sie nicht gibt). Beim Anlegen einer
    // Instanz gibt es sie nie; `SOURCE_COMMIT` dagegen hat Coolify nach dem
    // ersten Ausrollen schon selbst angelegt — leer, weil die Compose-Datei
    // sie erwähnt (siehe `InstanceProvisioningService.setSourceState`).
    const body = { key: key, value: value, is_preview: false };
    const created = await this.call('POST', `/applications/${uuid}/envs`, body, [409]);
    if (created !== null) return;
    await this.call('PATCH', `/applications/${uuid}/envs`, body);
  }

  async setDomain(uuid: string, fqdn: string): Promise<void> {
    await this.call('PATCH', `/applications/${uuid}`, {
      docker_compose_domains: [{ name: 'web', domain: `https://${fqdn}` }],
    });
  }

  async startDeploy(uuid: string): Promise<{ deploymentUuid: string }> {
    const raw = (await this.call(
      'POST',
      `/deploy?uuid=${encodeURIComponent(uuid)}&force=false`,
      {},
    )) as { deployments?: { deployment_uuid?: string }[] } | null;
    const deploymentUuid = raw?.deployments?.[0]?.deployment_uuid;
    if (typeof deploymentUuid !== 'string') {
      throw new Error('Coolify hat kein Deployment gemeldet.');
    }
    return { deploymentUuid };
  }

  async getDeployment(deploymentUuid: string): Promise<CoolifyDeployment> {
    const raw = (await this.call(
      'GET',
      `/deployments/${deploymentUuid}`,
    )) as Record<string, unknown> | null;
    const commit = raw?.['commit'];
    return {
      uuid: deploymentUuid,
      status: typeof raw?.['status'] === 'string' ? (raw['status'] as string) : 'unknown',
      // Nur ein echter Commit — „HEAD" oder ein leerer Wert wären als
      // Versionsangabe schlimmer als keine.
      commit: typeof commit === 'string' && /^[0-9a-f]{40}$/.test(commit) ? commit : null,
    };
  }

  async stopApplication(uuid: string): Promise<void> {
    // STOPPEN. Das Datenvolumen bleibt bestehen; es gibt hier keinen Aufruf,
    // der es entfernt, und es soll auch keinen geben (R1).
    //
    // POST, NICHT GET. Coolify hat den Endpunkt umgestellt; gegen 4.3.17
    // antwortet ein GET mit 405 und der Meldung „This endpoint has changed to
    // a POST request". Das Archivieren — neben dem Anlegen die einzige
    // erlaubte Schreiboperation gegen eine Kundeninstanz — waere damit still
    // gescheitert. Gemessen am laufenden Server.
    await this.call('POST', `/applications/${uuid}/stop`, {});
  }

  async deleteApplication(uuid: string, deleteVolumes: boolean): Promise<void> {
    // 404 = gibt es nicht (mehr): schon erledigt, kein Fehler. Das Token braucht dafür das Löschrecht.
    await this.call(
      'DELETE',
      `/applications/${encodeURIComponent(uuid)}?delete_volumes=${deleteVolumes}&delete_configurations=true&docker_cleanup=true`,
      undefined,
      [404],
    );
  }

  /**
   * Ein Aufruf gegen die API — mit endlicher Zeitgrenze.
   *
   * `stillStatus` nennt HTTP-Status, die kein Fehler sind, sondern `null`
   * bedeuten (z. B. 404 bei „Anwendung gibt es nicht mehr").
   */
  private async call(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    stillStatus: number[] = [],
  ): Promise<unknown> {
    const abort = new AbortController();
    const clock = setTimeout(() => abort.abort(), COOLIFY_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.coolifyConfig.apiUrl}${path}`, {
        method: method,
        signal: abort.signal,
        headers: {
          Authorization: `Bearer ${this.coolifyConfig.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (stillStatus.includes(response.status)) return null;
      const text = await response.text();
      if (!response.ok) {
        // =================================================================
        // DER ANTWORTTEXT GEHÖRT IN DIE MELDUNG
        // =================================================================
        //
        // Hier stand nur der Status. Genau daran ist am 07.09.2026 eine
        // Stunde verlorengegangen: Das Anlegen einer Instanz scheiterte mit
        // `422`, und `422` ist der EINE Status, dessen Rumpf sagt, WELCHES
        // Feld nicht stimmt. Coolify hatte die Antwort mitgeschickt — wir
        // haben sie gelesen und weggeworfen.
        //
        // Der Kommentar von damals begründete sogar schon, warum der Rumpf
        // mitgehen darf („kann Konfigurationsdetails enthalten, aber niemals
        // unser Token — das steht nur im Kopf der ANFRAGE"). Er zog daraus
        // nur nicht den Schluss.
        //
        // GEKÜRZT UND EINZEILIG: Die Meldung landet in `Instanz.meldung` und
        // damit in der Oberfläche. Ein mehrere Kilobyte langer HTML-Fehler
        // von einem Reverse-Proxy machte die Karte unlesbar.
        const reason = summary(text);
        this.logger.error(
          `Coolify ${method} ${path} antwortete ${response.status}: ${reason}`,
        );
        throw new Error(
          `Coolify antwortete ${response.status} auf ${method} ${path}` +
            (reason === '' ? '.' : `: ${reason}`),
        );
      }
      if (text.length === 0) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        // `/version` antwortet mit Klartext.
        return text.trim();
      }
    } finally {
      clearTimeout(clock);
    }
  }
}

/** Höchstlänge des Antwortauszugs in einer Fehlermeldung. */
export const REASON_MAX = 300;

/**
 * Macht aus einem Fehlerrumpf eine Zeile, die in eine Meldung passt.
 *
 * Bevorzugt die Felder, die Coolify bei einer Validierung schickt
 * (`message` und `errors`), weil dort genau steht, was fehlt. Ist der Rumpf
 * kein JSON — etwa eine HTML-Fehlerseite eines Proxys —, wird er entschärft
 * statt verworfen: Auch „<html><head><title>502 Bad Gateway" beantwortet die
 * Frage, wer da eigentlich geantwortet hat.
 */
export function summary(text: string): string {
  const raw = text.trim();
  if (raw === '') return '';
  let content = raw;
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof d['message'] === 'string') parts.push(d['message']);
    const errors = d['errors'];
    if (errors !== null && typeof errors === 'object') {
      for (const [field, messages] of Object.entries(
        errors as Record<string, unknown>,
      )) {
        const value = Array.isArray(messages)
          ? messages.join(' ')
          : String(messages);
        parts.push(`${field}: ${value}`);
      }
    }
    if (parts.length > 0) content = parts.join(' — ');
    else if (typeof d['error'] === 'string') content = d['error'];
  } catch {
    // Kein JSON — der Rohtext bleibt, gekürzt und einzeilig.
  }
  const oneRow = content.replace(/\s+/g, ' ').trim();
  return oneRow.length > REASON_MAX
    ? `${oneRow.slice(0, REASON_MAX)}…`
    : oneRow;
}

/**
 * Zieht die Liste aus einer Coolify-Antwort — oder `null`, wenn keine da ist.
 *
 * Coolify liefert Sammlungen je nach Version und Endpunkt entweder als nacktes
 * Array oder paginiert als `{ "data": [ … ] }`. BEIDE Formen werden gelesen;
 * alles andere gibt `null` und gilt dem Aufrufer als Ausfall ([K2]).
 *
 * Der Unterschied ist nicht kosmetisch: „leere Liste" heisst „die Subdomain
 * ist frei", „Ausfall" heisst „im Zweifel vergeben". Eine Fehldeutung an
 * dieser Stelle überschreibt fremde Deployments.
 */
export function listFrom(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object' && raw !== null) {
    const data = (raw as Record<string, unknown>)['data'];
    if (Array.isArray(data)) return data;
  }
  return null;
}

/** Liest die für uns bedeutsamen Felder aus einer Coolify-Antwort. */
function toApplication(raw: Record<string, unknown>): CoolifyApplication {
  return {
    uuid: typeof raw['uuid'] === 'string' ? raw['uuid'] : '',
    name: typeof raw['name'] === 'string' ? raw['name'] : '',
    status: typeof raw['status'] === 'string' ? raw['status'] : 'unknown',
    domains: domainsFrom(raw['docker_compose_domains']),
  };
}

/**
 * Zieht die Domänen aus `docker_compose_domains`.
 *
 * Coolify liefert das Feld je nach Version als Liste, als Objekt oder als
 * JSON-Zeichenkette. Das Provisionierungsskript umgeht das, indem es die ganze
 * Struktur nach der Zeichenkette durchsucht; hier wird derselbe Weg gegangen,
 * weil eine falsch geratene Form dazu führte, dass eine BEREITS VERGEBENE
 * Subdomain als frei gälte — genau der stille Datenverlust, den die
 * Verfügbarkeitsprüfung verhindern soll.
 */
export function domainsFrom(field: unknown): string[] {
  if (field === null || field === undefined) return [];
  const text = typeof field === 'string' ? field : JSON.stringify(field);
  const found = text.match(/[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+/gi);
  return found === null ? [] : [...new Set(found.map((d) => d.toLowerCase()))];
}
