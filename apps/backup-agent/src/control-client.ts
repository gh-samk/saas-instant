import type { BackupKind, InstanceSpec } from './types.js';
import { ControlLockedError } from './errors.js';
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

export type ArchiveDocKind = 'pdf' | 'xml' | 'xrechnung';

export interface ArchiveDocument {
  kind: ArchiveDocKind;
  base64: string;
  sha256: string;
}

export interface ArchiveItem {
  invoiceId: string;
  number: string;
  finalizedAt: string;
  documents: ArchiveDocument[];
}

export interface InvoiceArchivePage {
  items: ArchiveItem[];
  next: string | null;
}

export interface ControlClient {
  getPlan(): Promise<BackupPlan>;
  /** Eine Seite des Rechnungsarchivs (entschluesselt, nur bei entsperrter Verwaltung). Wirft ControlLockedError bei HTTP 423. */
  getInvoiceArchivePage(after?: string): Promise<InvoiceArchivePage>;
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

  async getInvoiceArchivePage(after?: string): Promise<InvoiceArchivePage> {
    const q = after ? `?after=${encodeURIComponent(after)}` : '';
    const r = await this.fetchFn(`${this.baseUrl}/api/internal/invoice-archive${q}`, {
      headers: { 'x-backup-key': this.key },
      signal: AbortSignal.timeout(60_000),
    });
    if (r.status === 423) throw new ControlLockedError();
    if (!r.ok) throw new Error(`Rechnungsarchiv nicht abrufbar (HTTP ${r.status})`);
    return parseArchivePage(await r.json());
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

const DOC_KINDS: readonly string[] = ['pdf', 'xml', 'xrechnung'];

function parseArchivePage(data: unknown): InvoiceArchivePage {
  if (!isRecord(data) || !Array.isArray(data['items'])) throw new Error('Rechnungsarchiv hat ein unerwartetes Format');
  const next = data['next'];
  if (next !== null && next !== undefined && typeof next !== 'string') throw new Error('Rechnungsarchiv hat ein unerwartetes Format');
  const items: ArchiveItem[] = [];
  for (const raw of data['items'] as unknown[]) {
    if (!isRecord(raw) || typeof raw['invoiceId'] !== 'string' || typeof raw['number'] !== 'string' || typeof raw['finalizedAt'] !== 'string' || !Array.isArray(raw['documents'])) {
      throw new Error('Rechnungsarchiv enthaelt einen ungueltigen Eintrag');
    }
    const documents: ArchiveDocument[] = [];
    for (const d of raw['documents'] as unknown[]) {
      if (!isRecord(d) || typeof d['kind'] !== 'string' || !DOC_KINDS.includes(d['kind']) || typeof d['base64'] !== 'string' || typeof d['sha256'] !== 'string') {
        throw new Error('Rechnungsarchiv enthaelt ein ungueltiges Dokument');
      }
      documents.push({ kind: d['kind'] as ArchiveDocKind, base64: d['base64'], sha256: d['sha256'] });
    }
    items.push({ invoiceId: raw['invoiceId'], number: raw['number'], finalizedAt: raw['finalizedAt'], documents });
  }
  return { items, next: typeof next === 'string' && next !== '' ? next : null };
}
