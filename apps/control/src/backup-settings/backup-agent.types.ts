/** Metadaten des Sicherungsziels, wie der Agent sie liefert (NIE Geheimnisse). */
export interface AgentTarget {
  type?: 's3' | 'storagebox';
  endpoint?: string;
  host?: string;
  port?: number;
  username?: string;
  bucket?: string;
  region?: string;
  path?: string;
  prefix?: string;
  pathStyle?: boolean;
  /** Storage Box: Anmeldeart (die Geheimnisse selbst kommen nie zurück). */
  authType?: 'key' | 'password';
  /** Storage Box: Fingerabdruck des SSH-Host-Keys (öffentlich, kein Geheimnis). */
  hostKeyFingerprint?: string;
  schedule?: 'daily' | 'twice_daily';
  retentionDays?: number;
  objectLock?: boolean;
  ageRecipient?: string;
}

/** Body von PUT /v1/target — enthält Geheimnisse; sie gehen NUR durch. */
export interface AgentTargetUpdate {
  type: 's3' | 'storagebox';
  schedule: 'daily' | 'twice_daily';
  retentionDays: number;
  objectLock: boolean;
  s3?: {
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    pathStyle: boolean;
    /** Weggelassen = der Agent behält den gespeicherten Wert. */
    accessKeyId?: string;
    secretAccessKey?: string;
  };
  storagebox?: {
    host: string;
    port: number;
    username: string;
    path: string;
    authType: 'key' | 'password';
    privateKey?: string;
    password?: string;
  };
}

/** Instanzbeschreibung für backup- und restore-Aufträge. */
export interface AgentInstance {
  subdomain: string;
  composeProject: string;
  dbService: string;
  dbName: string;
  dbUser: string;
  uploadsService?: string;
  uploadsPath?: string;
}

export type AgentJobRequest =
  | { kind: 'backup'; instance: AgentInstance }
  | { kind: 'backup-control' }
  | { kind: 'verify'; objectKey: string }
  | { kind: 'restore'; objectKey: string; ageIdentity: string; target: AgentInstance };

export interface AgentJob {
  id: string;
  kind: 'backup' | 'backup-control' | 'verify' | 'restore';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt?: string;
  message?: string;
  result?: { objectKey?: string; sizeBytes?: number; sha256?: string };
}

export interface AgentBackupEntry {
  objectKey: string;
  kind: 'instance' | 'control' | 'invoices';
  subdomain?: string;
  date: string;
  sizeBytes: number;
  sha256: string;
}
