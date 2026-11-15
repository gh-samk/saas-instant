import type { BackupKind, InstanceSpec } from './types.js';
import { isRecord, parseInstanceSpec } from './validate.js';

export interface BackupReport {
  subdomain?: string;
  kind: BackupKind;
  date: string;
  sizeBytes: number;
  objectKey: string;
  sha256: string;
}

export interface BackupPlan {
  /** Aufbewahrung der Rechnungsarchive in Jahren (Object Lock); fehlt beim alten Array-Format. */
  retentionYears?: number;
  instances: InstanceSpec[];
}

export interface ControlClient {
  getPlan(): Promise<BackupPlan>;
  report(entry: BackupReport): Promise<void>;
}

/** Gegenstelle: control-api (x-backup-key = BACKUP_REPORT_KEY). */
export class HttpControlClient implements ControlClient {
  constructor(
    private readonly baseUrl: string,
    private readonly key: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Neues Format: {retentionYears, instances: [...]}. Das alte Array-Format wird weiter toleriert. */
  async getPlan(): Promise<BackupPlan> {
    const r = await this.fetchFn(`${this.baseUrl}/api/internal/backup-plan`, {
      headers: { 'x-backup-key': this.key },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`Sicherungsplan nicht abrufbar (HTTP ${r.status})`);
    const data: unknown = await r.json();
    let list: unknown;
    let retentionYears: number | undefined;
    if (Array.isArray(data)) {
      list = data;
    } else if (isRecord(data) && Array.isArray(data['instances'])) {
      list = data['instances'];
      const y = data['retentionYears'];
      if (typeof y === 'number' && Number.isInteger(y) && y >= 1 && y <= 100) retentionYears = y;
    } else {
      throw new Error('Sicherungsplan hat ein unerwartetes Format');
    }
    const instances: InstanceSpec[] = [];
    for (const item of list as unknown[]) {
      try {
        instances.push(parseInstanceSpec(item));
      } catch {
        // Ungueltige Eintraege werden uebersprungen, der Rest wird gesichert.
      }
    }
    return { ...(retentionYears !== undefined ? { retentionYears } : {}), instances };
  }

  async report(entry: BackupReport): Promise<void> {
    const r = await this.fetchFn(`${this.baseUrl}/api/backups`, {
      method: 'POST',
      headers: { 'x-backup-key': this.key, 'content-type': 'application/json' },
      body: JSON.stringify(entry),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`Meldung an die Verwaltung fehlgeschlagen (HTTP ${r.status})`);
  }
}
