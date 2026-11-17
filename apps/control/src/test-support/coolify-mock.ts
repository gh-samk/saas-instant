import type {
  ApplicationCreate,
  CoolifyApplication,
  CoolifyClient,
  CoolifyDeployment,
} from '../coolify/coolify.types';

/**
 * ATTRAPPE DER COOLIFY-API — nur für Prüfläufe.
 *
 * WARUM SIE HIER LIEGT UND NICHT UNTER `src/coolify/`: `src/test-support/` ist
 * in `tsconfig.json` vom Übersetzen ausgeschlossen und landet damit NICHT im
 * Auslieferungsartefakt ([K3], festgehalten von `build-inhalt.spec.ts`). In
 * Etappe 2 lag ein Massenlöschpfad im Produktionsimage, weil Prüfcode
 * mitgebaut wurde — dieselbe Lehre gilt hier.
 *
 * SIE BILDET DIE ANTWORTFORMEN DES ECHTEN DIENSTES NACH, wie sie das
 * produktiv genutzte `Provisionierungsskript` erwartet: `uuid` beim
 * Anlegen, `deployments[0].deployment_uuid` beim Deploy, `status` beim
 * Verfolgen, `docker_compose_domains` bei der Auflistung.
 *
 * Löschen kann sie nur über `deleteApplication` — die einzige Löschmethode der
 * aufgezählten Schnittstelle (Löschung 90 Tage nach der Archivierung).
 */
/** Der Commit, den ein Deployment der Attrappe meldet — sofern nichts anderes gesetzt ist. */
export const MOCK_COMMIT = '0123456789abcdef0123456789abcdef01234567';

export class CoolifyMock implements CoolifyClient {
  /** Was der Dienst gerade „kennt". Frei beschreibbar für den jeweiligen Fall. */
  readonly applicationsList: CoolifyApplication[] = [];
  /** Zustand je Deployment. Vorgabe: sofort fertig. */
  readonly deployments = new Map<string, string>();
  /** Der Commit, den jedes Deployment meldet; `null` = Coolify nennt keinen. */
  commit: string | null = MOCK_COMMIT;
  /** Mitschrift aller Aufrufe — damit ein Test die REIHENFOLGE prüfen kann. */
  readonly calls: string[] = [];
  /** Gesetzte Umgebungsvariablen je Anwendung. */
  readonly environment = new Map<string, Record<string, string>>();
  /** Gestoppte Anwendungen. */
  readonly stopped: string[] = [];
  /** Gelöschte Anwendungen (UUID, mit oder ohne Volumes). */
  readonly deleted: { uuid: string; deleteVolumes: boolean }[] = [];

  /** Wenn gesetzt, wirft der nächste Aufruf dieses Namens. */
  failsAt: string | null = null;
  /** Basisdomäne für erzeugte Einträge. */
  baseDomain = 'apps.example.com';
  /**
   * Liest das Ausrollen die Compose-Datei? So tut es Coolify
   * (ApplicationDeploymentJob:696, synchron vor dem Bauen). `false` bildet
   * den Fall nach, dass selbst das nicht klappt — etwa ein Deploy-Key ohne
   * Zugriff.
   *
   * Coolifys EINGEREIHTER Job (`LoadComposeFile::dispatch`) kommt hier gar
   * nicht vor: Er liefert in der Attrappe nie. Jeder Test beweist damit,
   * dass der Aufbau nicht auf ihn angewiesen ist.
   */
  composeWhenDeploy = true;
  /**
   * Wie oft Coolify die Domäne NACH dem Laden noch ablehnt — bildet den
   * Augenblick nach, in dem der Stand noch nicht übernommen ist.
   */
  domainRefusals = 0;
  /**
   * Welche Anwendungen ihre Compose-Datei „gelesen" haben. INTERN, nicht in
   * der Antwort: Das Token der Verwaltung bekommt `docker_compose_raw` von
   * Coolify gar nicht zu sehen (gemessen am 12.09.2026), also darf die
   * Attrappe es auch nicht zeigen.
   */
  private readonly composeRead = new Set<string>();

  private count = 0;

  private book(name: string): void {
    this.calls.push(name);
    if (this.failsAt === name) {
      throw new Error(`Attrappe: ${name} scheitert absichtlich.`);
    }
  }

  async version(): Promise<string> {
    this.book('version');
    return '4.0.0-beta.420';
  }

  async applications(): Promise<CoolifyApplication[]> {
    this.book('applications');
    return [...this.applicationsList];
  }

  async getApplication(uuid: string): Promise<CoolifyApplication | null> {
    this.book('getApplication');
    return this.applicationsList.find((a) => a.uuid === uuid) ?? null;
  }

  async createApplication(store: ApplicationCreate): Promise<{ uuid: string }> {
    this.book('createApplication');
    this.count += 1;
    const uuid = `attrappe-app-${this.count}`;
    this.applicationsList.push({
      uuid,
      name: store.name,
      domains: [],
      status: 'exited',
    });
    this.environment.set(uuid, { ...store.environment });
    return { uuid };
  }

  async setEnvironmentVariable(
    uuid: string,
    key: string,
    value: string,
  ): Promise<void> {
    this.book('setEnvironmentVariable');
    const before = this.environment.get(uuid) ?? {};
    this.environment.set(uuid, { ...before, [key]: value });
  }

  async setDomain(uuid: string, fqdn: string): Promise<void> {
    this.book('setDomain');
    const application = this.applicationsList.find((a) => a.uuid === uuid);
    // DIESELBE ABLEHNUNG WIE COOLIFY (gemessen am 11.09.2026). Ohne sie waere
    // die Attrappe freundlicher als das Original, und genau der Fehler, der in
    // Betrieb auffiel, bliebe im Test unsichtbar.
    const notYet = !this.composeRead.has(uuid) || this.domainRefusals > 0;
    if (this.composeRead.has(uuid) && this.domainRefusals > 0) {
      this.domainRefusals -= 1;
    }
    if (application !== undefined && notYet) {
      throw new Error(
        'Coolify antwortete 422 auf PATCH /applications/' +
          `${uuid}: Validation failed. — docker_compose_domains: Cannot set ` +
          'docker_compose_domains without docker_compose_raw.',
      );
    }
    if (application !== undefined) application.domains = [fqdn];
  }

  async startDeploy(uuid: string): Promise<{ deploymentUuid: string }> {
    this.book('startDeploy');
    const deploymentUuid = `attrappe-deploy-${uuid}`;
    this.deployments.set(deploymentUuid, this.deployments.get(deploymentUuid) ?? 'finished');
    const application = this.applicationsList.find((a) => a.uuid === uuid);
    if (application !== undefined) application.status = 'running';
    if (this.composeWhenDeploy) this.composeRead.add(uuid);
    return { deploymentUuid };
  }

  async getDeployment(deploymentUuid: string): Promise<CoolifyDeployment> {
    this.book('getDeployment');
    return {
      uuid: deploymentUuid,
      status: this.deployments.get(deploymentUuid) ?? 'finished',
      commit: this.commit,
    };
  }

  async stopApplication(uuid: string): Promise<void> {
    this.book('stopApplication');
    this.stopped.push(uuid);
    const application = this.applicationsList.find((a) => a.uuid === uuid);
    if (application !== undefined) application.status = 'exited';
  }

  async deleteApplication(uuid: string, deleteVolumes: boolean): Promise<void> {
    this.book('deleteApplication');
    // Wie Coolify: eine unbekannte Anwendung (404) ist „schon erledigt".
    this.removeManually(uuid);
    this.deleted.push({ uuid, deleteVolumes });
  }

  /**
   * Bildet nach, dass jemand eine Anwendung in der Coolify-Oberflaeche von
   * Hand geloescht hat. Die Schnittstelle selbst kann das nicht (R1).
   */
  removeManually(uuid: string): void {
    const i = this.applicationsList.findIndex((a) => a.uuid === uuid);
    if (i >= 0) this.applicationsList.splice(i, 1);
  }

  /** Trägt eine bereits bestehende Anwendung ein (für Abgleich-Fälle). */
  setUp(name: string, domain: string, status = 'running'): CoolifyApplication {
    this.count += 1;
    const application: CoolifyApplication = {
      uuid: `attrappe-vorhanden-${this.count}`,
      name,
      domains: [domain],
      status,
    };
    this.composeRead.add(application.uuid);
    this.applicationsList.push(application);
    return application;
  }
}
