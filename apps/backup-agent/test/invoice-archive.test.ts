import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HttpControlClient, type ArchiveItem, type InvoiceArchivePage } from '../src/control-client.js';
import { ControlLockedError } from '../src/errors.js';
import { controlInvoiceSource } from '../src/invoices-http.js';
import { FakeControl, startHarness, s3Body } from './helpers.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const doc = (kind: 'pdf' | 'xml' | 'xrechnung', text: string, hash?: string) => {
  const b = Buffer.from(text);
  return { kind, base64: b.toString('base64'), sha256: hash ?? sha(b) };
};
const item = (id: string, number: string, finalizedAt: string, documents = [doc('pdf', `pdf-${number}`)]): ArchiveItem => ({
  invoiceId: id,
  number,
  finalizedAt,
  documents,
});

class PagedControl extends FakeControl {
  calls: (string | undefined)[] = [];
  constructor(private readonly pages: Record<string, InvoiceArchivePage>) {
    super();
  }
  override async getInvoiceArchivePage(after?: string) {
    this.calls.push(after);
    const p = this.pages[after ?? ''];
    if (!p) throw new Error('unbekannte Seite');
    return p;
  }
}

describe('Rechnungsarchiv ueber die Verwaltung', () => {
  it('folgt dem Seiten-Cursor, gruppiert nach Jahr und setzt die Dokumente zusammen', async () => {
    const c = new PagedControl({
      '': { items: [item('1', 'RE-2025-0001', '2025-12-30T10:00:00Z'), item('2', 'RE-2026-0001', '2026-01-05T10:00:00Z', [doc('pdf', 'p'), doc('xml', 'x'), doc('xrechnung', 'xr')])], next: 'c1' },
      c1: { items: [item('3', 'RE-2026-0002', '2026-02-01T10:00:00Z')], next: null },
    });
    const all = await controlInvoiceSource(c).fetchAll();
    expect(c.calls).toEqual([undefined, 'c1']);
    expect([...all.keys()].sort()).toEqual(['2025', '2026']);
    expect(all.get('2026')!.map((d) => d.number)).toEqual(['RE-2026-0001', 'RE-2026-0002']);
    const first = all.get('2026')![0]!;
    expect(first.pdf!.toString()).toBe('p');
    expect(first.xml!.toString()).toBe('x');
    expect(first.xrechnung!.toString()).toBe('xr');
  });

  it('Hashfehler: Lauf bricht ab, nichts wird archiviert', async () => {
    const bad = doc('pdf', 'echt', 'a'.repeat(64));
    const c = new PagedControl({ '': { items: [item('1', 'RE-1', '2026-01-01T00:00:00Z', [bad])], next: null } });
    await expect(controlInvoiceSource(c).fetchAll()).rejects.toThrow(/RE-1.*Pruefsumme/);
  });

  it('wiederholte Seitenmarke bricht ab (keine Endlosschleife)', async () => {
    const c = new PagedControl({ '': { items: [], next: 'x' }, x: { items: [], next: 'x' } });
    await expect(controlInvoiceSource(c).fetchAll()).rejects.toThrow(/Seitenmarke/);
  });

  it('HttpControlClient: 423 wird ControlLockedError, Cursor und Schluessel gehen mit', async () => {
    let seen: { url: string; key: string | undefined } | null = null;
    const mk = (status: number, body: unknown) =>
      new HttpControlClient('http://c', 'k', (async (url: string, init: RequestInit) => {
        seen = { url, key: (init.headers as Record<string, string>)['x-backup-key'] };
        return { ok: status < 300, status, json: async () => body };
      }) as unknown as typeof fetch);
    await expect(mk(423, {}).getInvoiceArchivePage()).rejects.toBeInstanceOf(ControlLockedError);
    await expect(mk(500, {}).getInvoiceArchivePage()).rejects.toThrow(/HTTP 500/);
    const page = await mk(200, { items: [], next: null }).getInvoiceArchivePage('a b');
    expect(page).toEqual({ items: [], next: null });
    expect(seen).toEqual({ url: 'http://c/api/internal/invoice-archive?after=a%20b', key: 'k' });
    await expect(mk(200, { items: [{ invoiceId: 1 }], next: null }).getInvoiceArchivePage()).rejects.toThrow(/ungueltig/);
  });
});

describe('gesperrte Verwaltung (423) -> deferred', () => {
  it('Job wird als deferred gemeldet, DB-Dump bleibt erhalten, erneuter Lauf archiviert', async () => {
    const h = await startHarness();
    try {
      await h.call('PUT', '/v1/target', s3Body({ objectLock: true }));
      h.invoices.docs = { '2026': [{ number: 'R-1', pdf: Buffer.from('pdf') }] };
      h.invoices.failWith = new ControlLockedError();
      const r = await h.call('POST', '/v1/jobs', { kind: 'backup-control' });
      const job = await h.waitJob(r.json.jobId);
      expect(job.status).toBe('deferred');
      expect(job.message).toMatch(/gesperrt/);
      const keys = [...h.storage.objects.keys()];
      expect(keys.some((k) => /control\/.*\.dump\.age$/.test(k))).toBe(true);
      expect(keys.some((k) => k.includes('/invoices/'))).toBe(false);

      h.invoices.failWith = null;
      const r2 = await h.call('POST', '/v1/jobs', { kind: 'backup-control' });
      expect((await h.waitJob(r2.json.jobId)).status).toBe('succeeded');
      expect([...h.storage.objects.keys()].some((k) => /invoices\/2026\/.*\.tar\.age$/.test(k))).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('der Planer versucht ein verschobenes Archiv erneut (hoechstens alle 10 Minuten), ohne neuen DB-Dump', async () => {
    const h = await startHarness();
    try {
      await h.call('PUT', '/v1/target', s3Body());
      h.invoices.docs = { '2026': [{ number: 'R-1', pdf: Buffer.from('pdf') }] };
      h.invoices.failWith = new ControlLockedError();
      const r = await h.call('POST', '/v1/jobs', { kind: 'backup-control' });
      expect((await h.waitJob(r.json.jobId)).status).toBe('deferred');
      const dumps = () => [...h.storage.objects.keys()].filter((k) => /control\/.*\.dump\.age$/.test(k)).length;
      expect(dumps()).toBe(1);

      h.invoices.failWith = null;
      const t0 = new Date(2026, 10, 15, 9, 0, 0);
      await h.app.scheduler.tick(t0);
      await h.app.queue.whenIdle();
      expect([...h.storage.objects.keys()].some((k) => /invoices\/2026\/.*\.tar\.age$/.test(k))).toBe(true);
      expect(dumps()).toBe(1);
      // Erfolgreich: kein weiterer Versuch.
      const before = h.storage.objects.size;
      await h.app.scheduler.tick(new Date(2026, 10, 15, 9, 30, 0));
      await h.app.queue.whenIdle();
      expect(h.storage.objects.size).toBe(before);
    } finally {
      await h.close();
    }
  });

  it('andere Fehler bleiben failed', async () => {
    const h = await startHarness();
    try {
      await h.call('PUT', '/v1/target', s3Body());
      h.invoices.failWith = new Error('Pruefsumme stimmt nicht');
      const r = await h.call('POST', '/v1/jobs', { kind: 'backup-control' });
      expect((await h.waitJob(r.json.jobId)).status).toBe('failed');
    } finally {
      await h.close();
    }
  });
});
