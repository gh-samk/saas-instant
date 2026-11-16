// Gemeinsame Typen des Backup-Agenten. Alles, was hier "Config" heisst und
// Geheimnisse enthaelt, verlaesst den Agenten nie (siehe target.ts: metadata()).

export type JobKind = 'backup' | 'backup-control' | 'verify' | 'restore';
export type BackupKind = 'instance' | 'control' | 'invoices';

export interface InstanceSpec {
  subdomain: string;
  composeProject: string;
  dbService: string;
  dbName: string;
  dbUser: string;
  uploadsService?: string;
  uploadsPath?: string;
}

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface StorageBoxConfig {
  host: string;
  port: number;
  username: string;
  path: string;
  authType: 'key' | 'password';
  privateKey?: string;
  password?: string;
  /** SHA-256-Fingerabdruck des Host-Keys ('SHA256:...'), per TOFU oder vorgegeben gepinnt. Nicht geheim. */
  hostKeyFingerprint?: string;
}

export interface TargetConfig {
  type: 's3' | 'storagebox';
  schedule: 'daily' | 'twice_daily';
  retentionDays: number;
  objectLock: boolean;
  s3?: S3Config;
  storagebox?: StorageBoxConfig;
}

export interface TargetState {
  target: TargetConfig;
  ageRecipient: string;
}

export interface JobResult {
  objectKey?: string;
  sizeBytes?: number;
  sha256?: string;
}

/** `deferred`: bewusst verschoben (z. B. Verwaltung gesperrt), kein Fehler; wird beim naechsten Lauf erneut versucht. */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'deferred';

export interface JobRecord {
  id: string;
  kind: JobKind;
  status: JobStatus;
  startedAt: string;
  finishedAt?: string;
  message?: string;
  result?: JobResult;
}

export interface BackupListEntry {
  objectKey: string;
  kind: BackupKind;
  subdomain?: string;
  date: string;
  sizeBytes: number;
  sha256: string;
}

export interface BackupMeta {
  version: 1;
  kind: BackupKind;
  subdomain?: string;
  createdAt: string;
  files: { name: string; sizeBytes: number; sha256: string }[];
  /** Nur Rechnungsarchive: Pruefsumme ueber die Klartext-Hashliste (Doppelungen vermeiden). */
  contentDigest?: string;
  year?: string;
}
