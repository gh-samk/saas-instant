import { Logger } from '@nestjs/common';
import {
  ProvisioningFailedError,
  type ProvisionedInstance,
  type Provisioner,
  type ProvisionHooks,
  type ProvisionRequest,
  type ProvisionResult,
  type Wait,
} from '../provisioning/provisioner';
import type { CoolifyApplication, CoolifyClient } from './coolify.types';

/** Wie oft der Zustand eines Deployments abgefragt wird (Millisekunden). */
export const DEPLOY_INTERVAL_MS = 15_000;
/** Zeitgrenze eines Deployments (Sekunden). */
export const DEPLOY_TIMEOUT_S = 600;
/**
 * Setzen der Domäne nach dem ersten Ausrollen: bei genau dem 422
 * „without docker_compose_raw" alle 3 s erneut, höchstens 40 Mal.
 */
export const COMPOSE_INTERVAL_MS = 3_000;
export const COMPOSE_ATTEMPTS = 40;

const logger = new Logger('CoolifyProvisioner');

/**
 * Der Coolify-Anbieter der Schnittstelle `Provisioner`.
 *
 * Genau vier Methoden: `create`, `status`, `stop`, `deleteApplication`. Hilfsfunktionen stehen
 * ausserhalb der Klasse, damit die Methodenliste prüfbar abschliessend bleibt
 * (`no-delete-path.spec.ts`). Die Logik ist die bisherige des
 * Instanz-Aufbaus, unverändert übernommen: erst ausrollen (Coolify liest dabei
 * die Compose-Datei), dann die Domäne, dann ein zweites Mal ausrollen.
 */
export class CoolifyProvisioner implements Provisioner {
  constructor(
    private readonly client: CoolifyClient,
    private readonly wait: Wait,
  ) {}

  async create(request: ProvisionRequest, hooks: ProvisionHooks = {}): Promise<ProvisionResult> {
    const progress = async (text: string): Promise<void> => {
      await hooks.onProgress?.(text);
    };

    await progress('Anwendung wird in Coolify angelegt …');
    const { uuid } = await this.client.createApplication({
      name: request.name,
      environment: request.environment,
    });
    await hooks.onCreated?.(uuid);

    await progress('Umgebungsvariablen werden gesetzt …');
    for (const [key, value] of Object.entries(request.environment)) {
      await this.client.setEnvironmentVariable(uuid, key, value);
    }

    // ERST AUSROLLEN, DANN DIE DOMÄNE: Coolify weist jede Domäne ab, solange
    // es die Compose-Datei nicht gelesen hat. Das Ausrollen liest sie
    // synchron (ApplicationDeploymentJob:696); die Container starten dabei
    // schon mit allen Geheimnissen, nur noch ohne Route und Zertifikat.
    const first = await rollOut(this.client, this.wait, uuid, request.name, 'erste', progress);

    await progress('Domäne wird gesetzt …');
    if (!(await setDomainWithPatience(this.client, this.wait, uuid, request.host))) {
      throw new ProvisioningFailedError(
        'Fehlgeschlagen: Coolify nimmt die Domäne auch nach dem ersten ' +
          'Ausrollen nicht an — es meldet, die Compose-Datei fehle. Die ' +
          `Anwendung ${request.name} steht in Coolify — bitte dort ` +
          'nachsehen (Deploy-Key, Branch, Pfad der Compose-Datei).',
      );
    }

    await setSourceState(this.client, uuid, first.commit);
    await rollOut(this.client, this.wait, uuid, request.name, 'zweite', progress);
    return { ref: uuid, commit: first.commit };
  }

  status(): Promise<ProvisionedInstance[]>;
  status(ref: string): Promise<ProvisionedInstance | null>;
  async status(ref?: string): Promise<ProvisionedInstance[] | ProvisionedInstance | null> {
    if (ref === undefined) {
      return (await this.client.applications()).map(toInstance);
    }
    const application = await this.client.getApplication(ref);
    return application === null ? null : toInstance(application);
  }

  async stop(ref: string): Promise<void> {
    await this.client.stopApplication(ref);
  }

  async deleteApplication(ref: string, deleteVolumes: boolean): Promise<void> {
    await this.client.deleteApplication(ref, deleteVolumes);
  }
}

function toInstance(a: CoolifyApplication): ProvisionedInstance {
  return { ref: a.uuid, name: a.name, domains: a.domains, status: a.status };
}

/** Rollt aus und wartet auf das Ende; wirft bei Scheitern. */
async function rollOut(
  client: CoolifyClient,
  wait: Wait,
  uuid: string,
  name: string,
  which: 'erste' | 'zweite',
  progress: (text: string) => Promise<void>,
): Promise<{ commit: string | null }> {
  await progress(
    which === 'erste'
      ? 'Erstes Ausrollen — dabei liest Coolify die Compose-Datei (einige Minuten) …'
      : 'Zweites Ausrollen, jetzt mit Domäne und Zertifikat (einige Minuten) …',
  );
  const { deploymentUuid } = await client.startDeploy(uuid);
  const { status, commit } = await waitOnDeployment(client, wait, deploymentUuid);
  if (status === 'finished') return { commit };
  throw new ProvisioningFailedError(
    `Fehlgeschlagen: Das ${which} Deployment endete mit „${status}". Die ` +
      `Anwendung ${name} steht in Coolify — bitte dort ` +
      'nachsehen. Lässt sie sich nicht retten: dort löschen, dann hier ' +
      'die Erstellung verwerfen.',
  );
}

/** Verfolgt das Deployment bis zum Ende oder bis zur Zeitgrenze. */
async function waitOnDeployment(
  client: CoolifyClient,
  wait: Wait,
  deploymentUuid: string,
): Promise<{ status: string; commit: string | null }> {
  const end = Date.now() + DEPLOY_TIMEOUT_S * 1000;
  let last = 'unbekannt';
  while (Date.now() < end) {
    const state = await client.getDeployment(deploymentUuid);
    last = state.status;
    if (['finished', 'failed', 'error', 'cancelled'].includes(state.status)) {
      return { status: state.status, commit: state.commit };
    }
    await wait(DEPLOY_INTERVAL_MS);
  }
  return { status: `Zeitüberschreitung (zuletzt: ${last})`, commit: null };
}

/**
 * Setzt die Domäne — und wartet einen Augenblick, falls Coolify die
 * Compose-Datei noch nicht übernommen hat. Die Antwort auf das Setzen ist die
 * Auskunft (das Token der Verwaltung sieht `docker_compose_raw` nicht): genau
 * der 422 „without docker_compose_raw" heisst „noch nicht", jeder andere
 * Fehler geht sofort nach oben.
 */
async function setDomainWithPatience(
  client: CoolifyClient,
  wait: Wait,
  uuid: string,
  host: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < COMPOSE_ATTEMPTS; attempt += 1) {
    try {
      await client.setDomain(uuid, host);
      return true;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!text.includes('without docker_compose_raw')) throw error;
      await wait(COMPOSE_INTERVAL_MS);
    }
  }
  return false;
}

/**
 * `SOURCE_COMMIT` = der Commit, den Coolify beim ersten Ausrollen WIRKLICH
 * ausgecheckt hat. Nur eine Anzeige: scheitert das Setzen, läuft der Aufbau
 * weiter.
 */
async function setSourceState(
  client: CoolifyClient,
  uuid: string,
  commit: string | null,
): Promise<void> {
  if (commit === null) {
    logger.warn(
      `Coolify hat für das erste Ausrollen von ${uuid} keinen Commit genannt — ` +
        'SOURCE_COMMIT bleibt leer, /api/version zeigt „dev".',
    );
    return;
  }
  try {
    await client.setEnvironmentVariable(uuid, 'SOURCE_COMMIT', commit);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(`SOURCE_COMMIT für ${uuid} ließ sich nicht setzen: ${reason}`);
  }
}
