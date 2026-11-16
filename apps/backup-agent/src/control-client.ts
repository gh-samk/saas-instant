import type { BackupKind, InstanceSpec } from './types.js';
import { ControlHttpError, ControlLockedError } from './errors.js';
import type { Logger } from './log.js';
import { isRecord, parseInstanceSpec } from './validate.js';

export interface BackupReport {
  subdomain?: string;
  kind: BackupKind;
  date: string;
  sizeBytes: number;
  /** Fehlen bei einem Lauf ohne neue Dateien (Rechnungsarchiv unveraendert oder leer). */
  objectKey?: string;
  sha256?: string;
  /** SHA-256 des verschluesselten Uploads-Archivs; fehlt ohne Uploads. */
  uploadsSha256?: string;
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

/** Beleg, den die Verwaltung nicht ausliefern konnte (z. B. nicht entschluesselbar). */
export interface SkippedInvoice {
  invoiceId: string;
  number: string;
  reason: string;
}

export interface InvoiceArchivePage {
  items: ArchiveItem[];
  /** Von der Verwaltung uebersprungene Belege; der Agent behandelt sie als Fehler. */
  skipped?: SkippedInvoice[];
  next: string | null;
}

export interface ControlClient {
  getPlan(): Promise<BackupPlan>;
  /** Eine Seite des Rechnungsarchivs (entschluesselt, nur bei entsperrter Verwaltung). Wirft ControlLockedError bei HTTP 423. */
  getInvoiceArchivePage(after?: string): Promise<InvoiceArchivePage>;
  report(entry: BackupReport): Promise<void>;
  /** Reicht zwischengespeicherte Meldungen nach (nur beim Zwischenspeicher-Client). */
  flush?(): Promise<void>;
}

/** Wartezeit bei HTTP 429: Retry-After (Sekunden) der Verwaltung, sonst wachsend; nie laenger als zwei Minuten. */
export function backoffMs(retryAfter: string | null, attempt: number): number {
  const secs = retryAfter !== null && /^\d{1,4}$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : NaN;
  const ms = Number.isFinite(secs) ? secs * 1000 : Math.min(2000 * 2 ** attempt, 60_000);
  return Math.min(Math.max(ms, 1000), 120_000);
}

const MAX_429_RETRIES = 8;

/** Gegenstelle: control-api (x-backup-key = BACKUP_REPORT_KEY). */
export class HttpControlClient implements ControlClient {
  constructor(
    private readonly baseUrl: string,
    private readonly key: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly opts: { log?: Logger; sleep?: (ms: number) => Promise<void> } = {},
  ) {}

  private sleep(ms: number): Promise<void> {
    return (this.opts.sleep ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n))))(ms);
  }

  /** Neues Format: {retentionYears, instances: [...]}. Das alte Array-Format wird weiter toleriert. */
  async getPlan(): Promise<BackupPlan> {
    const r = await this.fetchFn(`${this.baseUrl}/api/internal/backup-plan`, {
      headers: { 'x-backup-key': this.key },
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 423) throw new ControlLockedError('Verwaltung ist gesperrt (Tresor nicht entsperrt), Sicherungsplan nicht abrufbar (HTTP 423)');
    if (!r.ok) throw new ControlHttpError(r.status, `Sicherungsplan nicht abrufbar (HTTP ${r.status})`);
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
    (list as unknown[]).forEach((item, index) => {
      try {
        instances.push(parseInstanceSpec(item));
      } catch (e) {
        // Der Rest wird gesichert; der uebersprungene Eintrag darf aber nicht still verschwinden
        // (sonst bleibt eine Instanz unbemerkt ohne Sicherung). Der Fehlertext nennt nur Feldnamen.
        this.opts.log?.warn('Ungueltiger Eintrag im Sicherungsplan uebersprungen, die Instanz wird NICHT gesichert', {
          index,
          reason: e instanceof Error ? e.message : 'unbekannt',
        });
      }
    });
    return { ...(retentionYears !== undefined ? { retentionYears } : {}), instances };
  }

  async getInvoiceArchivePage(after?: string): Promise<InvoiceArchivePage> {
    const q = after ? `?after=${encodeURIComponent(after)}` : '';
    // Die Verwaltung drosselt (429); bei vielen Rechnungen waere der Lauf sonst unvermeidlich gescheitert.
    for (let attempt = 0; ; attempt++) {
      const r = await this.fetchFn(`${this.baseUrl}/api/internal/invoice-archive${q}`, {
        headers: { 'x-backup-key': this.key },
        signal: AbortSignal.timeout(60_000),
      });
      if (r.status === 423) throw new ControlLockedError();
      if (r.status === 429 && attempt < MAX_429_RETRIES) {
        const wait = backoffMs(r.headers.get('retry-after'), attempt);
        this.opts.log?.info('Rechnungsarchiv gedrosselt (429), neuer Versuch folgt', { waitMs: wait, attempt: attempt + 1 });
        await this.sleep(wait);
        continue;
      }
      if (!r.ok) throw new ControlHttpError(r.status, `Rechnungsarchiv nicht abrufbar (HTTP ${r.status})`);
      return parseArchivePage(await r.json());
    }
  }

  async report(entry: BackupReport): Promise<void> {
    const r = await this.fetchFn(`${this.baseUrl}/api/backups`, {
      method: 'POST',
      headers: { 'x-backup-key': this.key, 'content-type': 'application/json' },
      body: JSON.stringify(entry),
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 423) throw new ControlLockedError('Verwaltung ist gesperrt (Tresor nicht entsperrt), Meldung nicht angenommen (HTTP 423)');
    if (!r.ok) throw new ControlHttpError(r.status, `Meldung an die Verwaltung fehlgeschlagen (HTTP ${r.status})`);
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
  const skipped: SkippedInvoice[] = [];
  if (Array.isArray(data['skipped'])) {
    for (const raw of data['skipped'] as unknown[]) {
      if (isRecord(raw)) {
        skipped.push({
          invoiceId: String(raw['invoiceId'] ?? '').slice(0, 80),
          number: String(raw['number'] ?? '').slice(0, 80),
          reason: String(raw['reason'] ?? 'unbekannt').slice(0, 80),
        });
      }
    }
  }
  return { items, ...(skipped.length > 0 ? { skipped } : {}), next: typeof next === 'string' && next !== '' ? next : null };
}
