/**
 * DIE SCHNITTSTELLE ZUR BEREITSTELLUNG VON INSTANZEN (Provisioner).
 *
 * Die Verwaltung weiss nicht, WIE eine Instanz entsteht — nur, dass es einen
 * Anbieter gibt, der vier Dinge kann: anlegen, Auskunft geben, stoppen, löschen. In v1
 * gibt es genau einen Anbieter (`CoolifyProvisioner`); ein zweiter hinge an
 * derselben Schnittstelle.
 *
 * REGEL R1 ALS EIGENSCHAFT DER SCHNITTSTELLE: Es gibt "Instanz anlegen",
 * "Instanz stoppen" und, seit 1.2.0, das Löschen 90 Tage nach der Archivierung
 * (`deleteApplication`, nur vom `PurgeService` gerufen) — sonst KEINE Methode
 * zum Entfernen, Zerstören oder Zurücksetzen. Was hier nicht steht, lässt sich
 * nirgends aufrufen; das Datenvolumen einer Instanz überlebt jedes `stop`. `no-delete-path.spec.ts`
 * prüft die abschliessende Methodenliste über den Quellbaum nach.
 */

/** Was der Anbieter über eine Instanz weiss. */
export interface ProvisionedInstance {
  /** Kennung beim Anbieter (bei Coolify: die UUID der Anwendung). */
  ref: string;
  /** Name beim Anbieter, z. B. `instance-musterverein`. */
  name: string;
  /** Voll qualifizierte Domänen (Hostnamen ohne Schema). */
  domains: string[];
  /** Betriebszustand in der Sprache des Anbieters, z. B. `running`, `exited`. */
  status: string;
}

/** Was zum Anlegen nötig ist. Alles Instanzspezifische steht hier — nichts im Anbieter. */
export interface ProvisionRequest {
  /** Name beim Anbieter (`<Präfix>-<Subdomain>`). */
  name: string;
  /** Hostname der Instanz (ohne Schema). */
  host: string;
  /** Vollständige Umgebung der Instanz; Werte sind Geheimnisse. */
  environment: Record<string, string>;
}

/** Rückmeldungen während des (minutenlangen) Anlegens. */
export interface ProvisionHooks {
  /** Der Anbieter hat die Instanz angelegt; `ref` MUSS sofort festgehalten werden. */
  onCreated?(ref: string): Promise<void> | void;
  /** Klartext-Zwischenstand für die Oberfläche. */
  onProgress?(text: string): Promise<void> | void;
}

export interface ProvisionResult {
  ref: string;
  /** Der ausgecheckte Stand der Software (40 Hex-Zeichen), sofern bekannt. */
  commit: string | null;
}

export interface Provisioner {
  /**
   * Instanz anlegen: Anwendung erzeugen, Umgebung setzen, Domäne hängen,
   * ausrollen — und zurückkehren, wenn das Ausrollen durch ist.
   * Scheitert es, wirft sie `ProvisioningFailedError` mit lesbarem Grund.
   */
  create(request: ProvisionRequest, hooks?: ProvisionHooks): Promise<ProvisionResult>;

  /** Alle dem Anbieter bekannten Instanzen. Wirft bei Ausfall (kein Ausfall = "leer"). */
  status(): Promise<ProvisionedInstance[]>;
  /** Eine Instanz; `null`, wenn der Anbieter sie nicht (mehr) kennt. */
  status(ref: string): Promise<ProvisionedInstance | null>;

  /** Instanz stoppen. Die Daten bleiben bestehen (R1). */
  stop(ref: string): Promise<void>;

  /**
   * Instanz samt Volumes löschen — unwiderruflich. Einziger Aufrufer ist
   * `PurgeService` (90 Tage nach der Archivierung). Gibt es die Anwendung nicht
   * mehr, gilt das als erledigt.
   */
  deleteApplication(ref: string, deleteVolumes: boolean): Promise<void>;
}

/** Injektionsmarke der Schnittstelle. */
export const PROVISIONER = 'PROVISIONER';

/**
 * Das Anlegen ist gescheitert; `message` ist der fertige Klartext für den
 * Nutzer und wird unverändert in der Instanzkarte angezeigt.
 */
export class ProvisioningFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisioningFailedError';
  }
}

/** Wartet — auswechselbar, damit Prüfläufe nicht echt warten. */
export type Wait = (ms: number) => Promise<void>;

/** Injektionsmarke der Wartefunktion. */
export const WAIT = 'WAIT';

export const realWait: Wait = (ms) => new Promise((done) => setTimeout(done, ms));
