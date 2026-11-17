import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeStorage } from '../src/storage/fake.js';
import { SftpStorage, isMissingDirectory } from '../src/storage/sftp.js';
import { instance, s3Body, startHarness, type Harness } from './helpers.js';

let h: Harness;
afterEach(async () => {
  await h.close();
});

async function setUp(): Promise<void> {
  h = await startHarness();
  await h.call('PUT', '/v1/target', s3Body());
  for (const key of [
    'saas/instances/alt1/2026-08-01T023000Z.dump.age',
    'saas/instances/alt1/2026-08-01T023000Z.meta.json',
    'saas/instances/alt1/2026-11-01T023000Z.dump.age', // der neueste Satz geht mit
    'saas/instances/alt1/2026-11-01T023000Z.meta.json',
    'saas/instances/alt10/2026-11-01T023000Z.dump.age', // gleiches Praefix ohne Schraegstrich: bleibt
    'saas/instances/kunde2/2026-11-01T023000Z.dump.age',
    'saas/invoices/2026/archiv.tar.age',
    'saas/control/2026-11-01T023000Z.dump.age',
  ]) {
    await h.storage.put(key, Buffer.from('x'));
  }
}

/** Alles ausser den Verwaltungssicherungen, die der Planer bei jedem Lauf mit anlegt. */
const keys = () => [...h.storage.objects.keys()].filter((k) => !k.includes('/control/')).sort();

async function runPurge(subdomain: string) {
  h.control.purge = [subdomain];
  await h.app.scheduler.runAll();
  await h.app.queue.whenIdle();
}

describe('Loeschung archivierter Instanzen im Ziel', () => {
  it('loescht nur instances/<subdomain>/ (auch den neuesten Satz) und meldet purged', async () => {
    await setUp();
    await runPurge('alt1');
    expect(keys()).toEqual([
      'saas/instances/alt10/2026-11-01T023000Z.dump.age',
      'saas/instances/kunde2/2026-11-01T023000Z.dump.age',
      'saas/invoices/2026/archiv.tar.age',
    ]);
    expect(h.control.reports.filter((r) => r.kind === 'purged')).toEqual([
      { subdomain: 'alt1', kind: 'purged', date: '2026-11-15', sizeBytes: 0 },
    ]);
  });

  it('ist idempotent: ein zweiter Lauf findet nichts und meldet erneut', async () => {
    await setUp();
    await runPurge('alt1');
    await runPurge('alt1');
    expect(h.control.reports.filter((r) => r.kind === 'purged')).toHaveLength(2);
    expect(keys()).toHaveLength(3);
  });

  it('fasst invoices/ nie an, auch nicht ueber die Subdomain "invoices"', async () => {
    await setUp();
    await h.storage.put('saas/instances/invoices/2026-11-01T023000Z.dump.age', Buffer.from('x'));
    await runPurge('invoices');
    expect(h.storage.objects.has('saas/invoices/2026/archiv.tar.age')).toBe(true);
    expect(h.storage.objects.has('saas/instances/invoices/2026-11-01T023000Z.dump.age')).toBe(true);
    expect(h.control.reports.filter((r) => r.kind === 'purged')).toEqual([]);
    expect(h.storage.deleted.some((k) => k.includes('invoices/'))).toBe(false);
  });

  it('weist eine Subdomain mit Pfadausbruch ab, ohne etwas zu loeschen', async () => {
    await setUp();
    const before = keys();
    for (const evil of ['../control', 'a/../b', 'alt1/', '']) {
      h.control.purge = [evil];
      await h.app.scheduler.runAll();
    }
    await h.app.queue.whenIdle();
    expect(keys()).toEqual(before);
  });

  it('meldet nichts, wenn das Loeschen scheitert (Object Lock)', async () => {
    await setUp();
    h.storage.objects.get('saas/instances/alt1/2026-11-01T023000Z.dump.age')!.retainUntil = new Date('2030-01-01T00:00:00Z');
    await runPurge('alt1');
    expect(h.control.reports.filter((r) => r.kind === 'purged')).toEqual([]);
  });

  it('der Sicherungslauf einer Instanz bleibt unberuehrt, wenn die Loeschliste fehlt', async () => {
    await setUp();
    h.control.plan = [instance({ subdomain: 'kunde2' })];
    await h.app.scheduler.runAll();
    await h.app.queue.whenIdle();
    expect(h.storage.deleted).toEqual([]);
  });

  it('meldet nichts, wenn das Auflisten scheitert (kein Fehler wird als leeres Praefix gewertet)', async () => {
    class ListFails extends FakeStorage {
      failing = false;
      override async list(prefix: string) {
        if (this.failing) throw new Error('SFTP: Verbindung abgebrochen');
        return super.list(prefix);
      }
    }
    const storage = new ListFails();
    h = await startHarness({ storage });
    await h.call('PUT', '/v1/target', s3Body());
    await storage.put('saas/instances/alt1/2026-11-01T023000Z.dump.age', Buffer.from('x'));
    storage.failing = true;
    await runPurge('alt1');
    expect(h.control.reports.filter((r) => r.kind === 'purged')).toEqual([]);
    expect(storage.objects.has('saas/instances/alt1/2026-11-01T023000Z.dump.age')).toBe(true);
  });

  it('SFTP: nur ein fehlendes Verzeichnis gilt als leer', () => {
    expect(isMissingDirectory(Object.assign(new Error('list: No such file /b/instances'), { code: 2 }))).toBe(true);
    expect(isMissingDirectory(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(true);
    expect(isMissingDirectory(Object.assign(new Error('Permission denied'), { code: 3 }))).toBe(false);
    expect(isMissingDirectory(new Error('Connection lost'))).toBe(false);
  });

  it('SFTP: ein Symlink im Praefix zaehlt als vorhandenes Objekt', async () => {
    const entry = (name: string, type: string) => ({ name, type, size: 3, modifyTime: 0 });
    const client = {
      list: async (dir: string) => (dir === '/b/instances/x' ? [entry('link', 'l'), entry('a.age', '-')] : []),
      end: async () => undefined,
    };
    const st = new SftpStorage({ host: 'h', port: 1, username: 'u', path: '/b', authType: 'password', password: 'p', hostKeyFingerprint: 'fp' });
    vi.spyOn(st as unknown as { open(): Promise<unknown> }, 'open').mockResolvedValue(client);
    expect((await st.list('instances/x/')).map((o) => o.key)).toEqual(['instances/x/link', 'instances/x/a.age']);
  });
});
