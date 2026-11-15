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
  years(): Promise<string[]>;
  ofYear(year: string): AsyncIterable<InvoiceDoc>;
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
  controlDump: () => ExecHandle;
  invoices: () => InvoiceSource;
  /** Compose-Projekte, die der Agent nie als Restore-Ziel akzeptiert. */
  ownProjects: () => Promise<Set<string>>;
}
