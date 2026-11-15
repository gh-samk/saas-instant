/**
 * DIE VOLLSTÄNDIGE AUFZÄHLUNG DESSEN, WAS DAS CRM GEGEN COOLIFY TUN DARF.
 *
 * Harte Regel R1, wörtlich: „Auf Kundeninstanzen existieren genau ZWEI
 * Schreibvorgänge: Instanz anlegen und Instanz stoppen/archivieren. Beide
 * laufen über die Coolify-API, beide nur nach ausdrücklicher Bestätigung durch
 * den Benutzer im UI. KEIN LÖSCHEN von Deployments oder Datenbanken aus dem
 * CRM heraus — weder im UI noch in der API noch in einem Skript."
 *
 * Diese Schnittstelle ist die Umsetzung dieses Satzes als EIGENSCHAFT, nicht
 * als Verabredung: Was hier nicht steht, lässt sich nirgends aufrufen. Es gibt
 * keine Methode zum Löschen, Zerstören, Entfernen oder Zurücksetzen — und
 * `no-delete-path.spec.ts` prüft das über den ganzen Quellbaum nach, damit
 * eine spätere Ergänzung nicht unbemerkt bleibt.
 *
 * Die Methoden zerfallen in drei Gruppen:
 *   LESEND      — version, anwendungen, holeAnwendung, holeDeployment
 *   SCHREIBEND 1 — legeAnwendungAn, setzeUmgebungsvariable, setzeDomaene,
 *                  starteDeploy  (zusammen: „Instanz anlegen")
 *   SCHREIBEND 2 — stoppeAnwendung  („Instanz stoppen/archivieren")
 *
 * NICHT GEGEN DIE ECHTE API BELEGT: Die Coolify-API ist ausschliesslich über
 * einen SSH-Tunnel erreichbar, und ein eigenes CRM-Token existiert noch nicht.
 * JEDER Pfad und jede Nutzlast hier stammt aus dem produktiv genutzten
 * Referenzskript `reference/provision-tenant.py` —
 * es gibt in dieser Schnittstelle keinen einzigen erfundenen Aufruf mehr.
 *
 * ES GAB EINEN ([W2]): `loeseSicherungAus` (`POST /databases/{uuid}/backups`)
 * hatte im Skript keine Entsprechung, und die UUID, die er gebraucht hätte,
 * wurde nirgends befüllt — die Datenbank einer Instanz liegt in deren
 * Compose-Stapel und ist keine eigene Coolify-Ressource. Der Aufruf war damit
 * toter Code UND ein erfundener Beleg zugleich. Er ist entfernt; die
 * abschliessende Sicherung ist ausdrücklich ein Handgriff geworden
 * (`docs/operations/backup-and-recovery.md`), und die Archivierung SAGT, wie der
 * Sicherungsstand ist, statt etwas zu behaupten.
 */

/** Eine Anwendung, wie Coolify sie in `GET /applications` auflistet. */
export interface CoolifyApplication {
  uuid: string;
  name: string;
  /** Voll qualifizierte Domänen, aus `docker_compose_domains` gelesen. */
  domains: string[];
  /** Betriebszustand, z. B. `running`, `exited`, `degraded`. */
  status: string;
  // KEIN FELD FÜR DIE COMPOSE-DATEI, mit Absicht. `docker_compose_raw` ist
  // bei Coolify ein SENSIBLES Feld; das Token der Verwaltung hat kein
  // `read:sensitive`, und Coolify lässt es in seinen Antworten dann ganz weg
  // (gemessen am 12.09.2026). Ein Feld hier stünde unter diesem Token immer
  // auf „nicht geladen" — genau daran ist der vierte Versuch gescheitert.
}

/** Zustand eines laufenden Deployments. */
export interface CoolifyDeployment {
  uuid: string;
  /** `queued`, `in_progress`, `finished`, `failed`, `error`, `cancelled`. */
  status: string;
  /**
   * Der Commit, den Coolify für dieses Deployment WIRKLICH ausgecheckt hat
   * (40 Hex-Zeichen), sonst `null`. Coolify schreibt ihn nach dem Klonen
   * fort (ApplicationDeploymentJob:2535); die Deployment-API liefert ihn mit.
   */
  commit: string | null;
}

/** Die Angaben, mit denen eine neue Anwendung angelegt wird. */
export interface ApplicationCreate {
  name: string;
  /** Nur die Namen und Werte der Umgebung; Werte sind Geheimnisse. */
  environment: Record<string, string>;
}

export interface CoolifyClient {
  /** Lebenszeichen der API. Wirft, wenn sie nicht erreichbar ist. */
  version(): Promise<string>;

  /** Alle Anwendungen des Projekts. Grundlage von Abgleich und Namensprüfung. */
  applications(): Promise<CoolifyApplication[]>;

  /** Eine Anwendung; `null`, wenn Coolify sie nicht (mehr) kennt. */
  getApplication(uuid: string): Promise<CoolifyApplication | null>;

  /** SCHREIBVORGANG 1a: legt die Anwendung an und gibt ihre UUID zurück. */
  createApplication(data: ApplicationCreate): Promise<{ uuid: string }>;

  /** SCHREIBVORGANG 1b: setzt eine Umgebungsvariable an der Anwendung. */
  setEnvironmentVariable(
    uuid: string,
    key: string,
    value: string,
  ): Promise<void>;

  /** SCHREIBVORGANG 1c: hängt die Domäne an den Dienst `web`. */
  setDomain(uuid: string, fqdn: string): Promise<void>;

  /** SCHREIBVORGANG 1d: stösst das Deployment an. */
  startDeploy(uuid: string): Promise<{ deploymentUuid: string }>;

  /** Zustand eines Deployments. */
  getDeployment(deploymentUuid: string): Promise<CoolifyDeployment>;

  /**
   * SCHREIBVORGANG 2: stoppt die Anwendung.
   *
   * STOPPEN, NICHT LÖSCHEN. Die Container werden angehalten, das
   * Datenvolumen bleibt bestehen. Es gibt keinen Aufruf, der es entfernt.
   *
   * Das ist der LETZTE Schreibvorgang der Schnittstelle. Danach kommt nichts
   * mehr — kein Aufräumen, kein Entfernen, kein Zurückspielen.
   */
  stopApplication(uuid: string): Promise<void>;
}

/** Injektionsmarke für den Client. */
export const COOLIFY_CLIENT = 'COOLIFY_CLIENT';
