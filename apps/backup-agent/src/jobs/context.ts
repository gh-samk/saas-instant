import type { ControlClient } from '../control-client.js';
import type { DockerClient, ExecHandle } from '../docker/types.js';
import type { Logger, Redactor } from '../log.js';
import type { Storage } from '../storage/types.js';
import type { TargetConfig } from '../types.js';

export interface InvoiceDoc {
  number: string;
  pdf?: Buffer | null;
  xml?: Buffer | null;
  xrechnung?: Buffer | null;
}

export interface InvoiceSource {
  /** Alle festgeschriebenen Rechnungen, nach Jahr gruppiert (Pruefsummen sind bereits geprueft). */
  fetchAll(): Promise<Map<string, InvoiceDoc[]>>;
  /** Belege, die die Verwaltung beim letzten fetchAll uebersprungen hat (z. B. nicht entschluesselbar). */
  skipped?(): { number: string; reason: string }[];
}

export interface JobContext {
  storage: Storage;
  target: TargetConfig;
  keyPrefix: string;
  recipient: string;
  docker: DockerClient;
  control: ControlClient;
  log: Logger;
  redactor: Redactor;
  workDir: string;
  now: () => Date;
  invoiceRetentionYears: number;
  /** pg_dump der Verwaltungsdatenbank (lokal im Agenten). */
  controlDump: (signal?: AbortSignal) => ExecHandle;
  invoices: () => InvoiceSource;
  /** Compose-Projekte, die der Agent nie als Restore-Ziel akzeptiert (eigener Stack). */
  ownProjects: () => Promise<Set<string>>;
  /** Sperrliste fuer Restore-Ziele: Namen oder Praefixe mit `*` am Ende (Verwaltung, Portal, portal-auth). */
  deniedProjects: string[];
  /** Wird beim Zeitlimit des Auftrags ausgeloest; Datenstroeme und Kindprozesse werden dann beendet. */
  signal?: AbortSignal;
}
