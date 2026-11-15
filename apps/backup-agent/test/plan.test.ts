import { describe, expect, it } from 'vitest';
import { HttpControlClient } from '../src/control-client.js';
import { instance, s3Body, startHarness } from './helpers.js';

const spec = instance();
const client = (data: unknown, ok = true) =>
  new HttpControlClient('http://c', 'k', (async () => ({ ok, status: ok ? 200 : 500, json: async () => data })) as unknown as typeof fetch);

describe('Sicherungsplan (control-client)', () => {
  it('liest das neue Objektformat mit retentionYears', async () => {
    expect(await client({ retentionYears: 8, instances: [spec] }).getPlan()).toEqual({ retentionYears: 8, instances: [spec] });
  });
  it('toleriert das alte Array-Format (ohne Frist)', async () => {
    expect(await client([spec]).getPlan()).toEqual({ instances: [spec] });
  });
  it('ignoriert ungueltige Fristen und ungueltige Eintraege', async () => {
    const p = await client({ retentionYears: 0, instances: [spec, { subdomain: '../x' }] }).getPlan();
    expect(p).toEqual({ instances: [spec] });
    expect((await client({ retentionYears: 1.5, instances: [] }).getPlan()).retentionYears).toBeUndefined();
  });
  it('lehnt unbekannte Formate und HTTP-Fehler ab', async () => {
    await expect(client({ foo: 1 }).getPlan()).rejects.toThrow(/Format/);
    await expect(client('x').getPlan()).rejects.toThrow(/Format/);
    await expect(client([], false).getPlan()).rejects.toThrow(/HTTP 500/);
  });
});

describe('Aufbewahrung der Rechnungsarchive aus dem Plan', () => {
  async function lockedRetain(retentionYears: number | undefined) {
    const h = await startHarness();
    try {
      await h.call('PUT', '/v1/target', s3Body({ objectLock: true }));
      h.control.retentionYears = retentionYears;
      h.invoices.docs = { '2026': [{ number: 'R-1', pdf: Buffer.from('pdf') }] };
      const r = await h.call('POST', '/v1/jobs', { kind: 'backup-control' });
      await h.waitJob(r.json.jobId);
      const locked = [...h.storage.objects.entries()].filter(([k, o]) => k.includes('invoices/') && o.retainUntil);
      expect(locked.length).toBeGreaterThan(0);
      const years = (locked[0]![1].retainUntil!.getTime() - h.clock.now.getTime()) / (365.25 * 86_400_000);
      return Math.round(years);
    } finally {
      await h.close();
    }
  }
  it('retentionYears aus dem Plan hat Vorrang', async () => {
    expect(await lockedRetain(6)).toBe(6);
  });
  it('ohne Plan-Wert gilt der Rueckfall (INVOICE_RETENTION_YEARS, hier 10)', async () => {
    expect(await lockedRetain(undefined)).toBe(10);
  });
});
