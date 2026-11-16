import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptBuffer } from '../src/age.js';
import { parseTar } from '../src/tar.js';
import { FakeDocker, S3_KEY_ID, S3_SECRET, instance, s3Body, startHarness, type Harness } from './helpers.js';

let h: Harness;
let identity: string;

async function setup() {
  h = await startHarness();
  const r = await h.call('PUT', '/v1/target', s3Body());
  expect(r.status).toBe(200);
  identity = r.json.ageIdentity;
  // Quell-Stack (Instanz) und ein leerer Ziel-Stack fuer die Wiederherstellung
  h.docker.add({ id: 'src-db', project: 'coolify-kunde1', service: 'db', running: true, db: 'DUMP-INHALT-KUNDE1' });
  h.docker.add({ id: 'src-web', project: 'coolify-kunde1', service: 'web', running: true, uploads: 'UPLOADS-KUNDE1' });
  h.docker.add({ id: 'new-db', project: 'coolify-kunde1-neu', service: 'db', running: true, db: 'LEER' });
  h.docker.add({ id: 'new-web', project: 'coolify-kunde1-neu', service: 'web', running: true, uploads: 'LEER' });
  h.docker.add({ id: 'own-db', project: 'saas-instant-main', service: 'control-db', running: true, db: 'VERWALTUNG' });
}

async function job(body: unknown) {
  const r = await h.call('POST', '/v1/jobs', body);
  expect(r.status).toBe(202);
  return h.waitJob(r.json.jobId);
}

beforeEach(setup);
afterEach(() => h.close());

describe('Zielverwaltung', () => {
  it('liefert den privaten Schluessel nur einmal und nie Geheimnisse in Metadaten', async () => {
    expect(identity).toMatch(/^AGE-SECRET-KEY-1/);
    const again = await h.call('PUT', '/v1/target', s3Body({ retentionDays: 60 }));
    expect(again.status).toBe(200);
    expect(again.json.ageIdentity).toBeUndefined();
    const meta = await h.call('GET', '/v1/target');
    expect(meta.json).toMatchObject({ type: 's3', bucket: 'bkp', retentionDays: 60, objectLock: false, ageRecipient: expect.stringMatching(/^age1/) });
    for (const t of [meta.text, again.text, JSON.stringify(h.app.targets.metadata())]) {
      expect(t).not.toContain(S3_SECRET);
      expect(t).not.toContain(S3_KEY_ID);
    }
    // Geheimnis darf bei erneutem Speichern fehlen (bleibt erhalten)
    const body = s3Body();
    delete (body.s3 as Record<string, unknown>).secretAccessKey;
    expect((await h.call('PUT', '/v1/target', body)).status).toBe(200);
  });

  it('lehnt ungueltige Konfiguration ab, ohne Werte zu zeigen', async () => {
    const r = await h.call('PUT', '/v1/target', s3Body({ retentionDays: 0 }));
    expect(r.status).toBe(400);
    expect(r.text).not.toContain(S3_SECRET);
  });

  it('Verbindungstest schreibt, liest, vergleicht und loescht', async () => {
    const r = await h.call('POST', '/v1/target/test');
    expect(r.json.ok).toBe(true);
    expect(h.storage.objects.size).toBe(0);
  });
});

describe('Backup, Liste, Pruefung, Restore', () => {
  it('Roundtrip: sichern, listen, pruefen, in fremden Stack wiederherstellen', async () => {
    const b = await job({ kind: 'backup', instance: instance() });
    expect(b.status).toBe('succeeded');
    expect(b.result.objectKey).toMatch(/^saas\/instances\/kunde1\/2026-11-15T023000Z\.dump\.age$/);

    // Chiffrat ist verschluesselt, mit privatem Schluessel entschluesselbar
    const stored = h.storage.objects.get(b.result.objectKey)!.data;
    expect(stored.includes(Buffer.from('DUMP-INHALT-KUNDE1'))).toBe(false);
    expect((await decryptBuffer(identity, stored)).toString()).toBe('DUMP-INHALT-KUNDE1');

    // Meldung an die Verwaltung
    expect(h.control.reports).toEqual([
      expect.objectContaining({ subdomain: 'kunde1', kind: 'instance', date: '2026-11-15', objectKey: b.result.objectKey, sha256: b.result.sha256, uploadsSha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    ]);

    const list = await h.call('GET', '/v1/backups?kind=instance&subdomain=kunde1');
    expect(list.json).toEqual([
      expect.objectContaining({ objectKey: b.result.objectKey, kind: 'instance', subdomain: 'kunde1', date: '2026-11-15', sha256: b.result.sha256 }),
    ]);

    const v = await job({ kind: 'verify', objectKey: b.result.objectKey });
    expect(v.status).toBe('succeeded');

    const r = await job({ kind: 'restore', objectKey: b.result.objectKey, sha256: b.result.sha256, uploadsSha256: h.control.reports[0]!.uploadsSha256, ageIdentity: identity, target: instance({ composeProject: 'coolify-kunde1-neu', subdomain: 'kunde1-neu' }) });
    expect(r.status).toBe('succeeded');
    const nd = h.docker.containers.find((c) => c.id === 'new-db')!;
    const nw = h.docker.containers.find((c) => c.id === 'new-web')!;
    expect(nd.db).toBe('DUMP-INHALT-KUNDE1');
    expect(nw.uploads).toBe('UPLOADS-KUNDE1');
    expect(nw.running).toBe(true);
    // Quelle blieb unberuehrt
    expect(h.docker.calls.filter((c) => c.startsWith('stop:')).every((c) => c === 'stop:new-web')).toBe(true);
    expect(JSON.stringify(h.app.queue.get(r.id))).not.toContain(identity);
  });

  it('verify erkennt eine veraenderte Datei', async () => {
    const b = await job({ kind: 'backup', instance: instance() });
    h.storage.objects.get(b.result.objectKey)!.data = Buffer.from('manipuliert');
    const v = await job({ kind: 'verify', objectKey: b.result.objectKey });
    expect(v.status).toBe('failed');
  });

  it('Backup scheitert ohne Container und hinterlaesst nichts', async () => {
    const j = await job({ kind: 'backup', instance: instance({ composeProject: 'gibt-es-nicht' }) });
    expect(j.status).toBe('failed');
    expect(h.storage.objects.size).toBe(0);
  });

  it('lehnt Restore in den eigenen Stack ab und ruehrt nichts an', async () => {
    const b = await job({ kind: 'backup', instance: instance() });
    h.docker.calls.length = 0;
    const r = await job({ kind: 'restore', objectKey: b.result.objectKey, sha256: b.result.sha256, ageIdentity: identity, target: instance({ composeProject: 'saas-instant-main', dbService: 'control-db', subdomain: 'x' }) });
    expect(r.status).toBe('failed');
    expect(h.docker.calls).toEqual([]);
    expect(h.docker.containers.find((c) => c.id === 'own-db')!.db).toBe('VERWALTUNG');
  });

  it('lehnt Restore ab, wenn der eigene Stack nicht ermittelbar ist (fail closed)', async () => {
    const b = await job({ kind: 'backup', instance: instance() });
    h.docker.own = null;
    const r = await job({ kind: 'restore', objectKey: b.result.objectKey, sha256: b.result.sha256, ageIdentity: identity, target: instance({ composeProject: 'coolify-kunde1-neu' }) });
    expect(r.status).toBe('failed');
    expect(h.docker.containers.find((c) => c.id === 'new-db')!.db).toBe('LEER');
  });

  it('lehnt ein unbekanntes Projekt ab', async () => {
    const b = await job({ kind: 'backup', instance: instance() });
    const r = await job({ kind: 'restore', objectKey: b.result.objectKey, sha256: b.result.sha256, ageIdentity: identity, target: instance({ composeProject: 'fremdes-projekt' }) });
    expect(r.status).toBe('failed');
  });

  it('falscher Schluessel: Ziel bleibt unveraendert und laeuft weiter', async () => {
    const b = await job({ kind: 'backup', instance: instance() });
    const other = (await (await import('../src/age.js')).newKeyPair()).identity;
    h.docker.calls.length = 0;
    const r = await job({ kind: 'restore', objectKey: b.result.objectKey, sha256: b.result.sha256, ageIdentity: other, target: instance({ composeProject: 'coolify-kunde1-neu' }) });
    expect(r.status).toBe('failed');
    expect(h.docker.calls.some((c) => c.startsWith('stop:'))).toBe(false);
    expect(h.docker.containers.find((c) => c.id === 'new-db')!.db).toBe('LEER');
  });

  it('nicht leere Ziel-Datenbank: abgelehnt, nichts angehalten, nichts veraendert', async () => {
    const b = await job({ kind: 'backup', instance: instance() });
    h.docker.containers.find((c) => c.id === 'new-db')!.tables = 3;
    h.docker.calls.length = 0;
    const r = await job({ kind: 'restore', objectKey: b.result.objectKey, sha256: b.result.sha256, ageIdentity: identity, target: instance({ composeProject: 'coolify-kunde1-neu' }) });
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/nicht leer/);
    expect(h.docker.calls.some((c) => c.startsWith('stop:') || c.includes('pg_restore'))).toBe(false);
    expect(h.docker.containers.find((c) => c.id === 'new-db')!.db).toBe('LEER');
  });

  it('nicht leere Ziel-Datenbank: eine vom Agenten gestartete DB wird wieder gestoppt, eine laufende bleibt', async () => {
    const b = await job({ kind: 'backup', instance: instance() });
    const nd = h.docker.containers.find((c) => c.id === 'new-db')!;
    nd.tables = 3;
    nd.running = false;
    const body = { kind: 'restore', objectKey: b.result.objectKey, sha256: b.result.sha256, ageIdentity: identity, target: instance({ composeProject: 'coolify-kunde1-neu' }) };
    expect((await job(body)).status).toBe('failed');
    expect(nd.running).toBe(false);
    h.docker.calls.length = 0;
    nd.running = true;
    expect((await job(body)).status).toBe('failed');
    expect(nd.running).toBe(true);
    expect(h.docker.calls).not.toContain('stop:new-db');
  });

  it('psql-Ausgabe nicht numerisch: Abbruch ohne Aenderung', async () => {
    const b = await job({ kind: 'backup', instance: instance() });
    h.docker.containers.find((c) => c.id === 'new-db')!.psqlOut = 'FEHLER';
    const r = await job({ kind: 'restore', objectKey: b.result.objectKey, sha256: b.result.sha256, ageIdentity: identity, target: instance({ composeProject: 'coolify-kunde1-neu' }) });
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/nicht geprueft/);
    expect(h.docker.calls.some((c) => c.startsWith('stop:') || c.includes('pg_restore'))).toBe(false);
  });

  it('pg_restore-Fehler: App-Container werden wieder gestartet, Fehlertext ohne Geheimnisse', async () => {
    const b = await job({ kind: 'backup', instance: instance() });
    h.docker.failRestore = true;
    const r = await job({ kind: 'restore', objectKey: b.result.objectKey, sha256: b.result.sha256, ageIdentity: identity, target: instance({ composeProject: 'coolify-kunde1-neu' }) });
    expect(r.status).toBe('failed');
    expect(h.docker.containers.find((c) => c.id === 'new-web')!.running).toBe(true);
    expect(r.message).not.toContain(identity);
  });

  describe('Uploads-Pruefsumme der Verwaltung', () => {
    const target = () => instance({ composeProject: 'coolify-kunde1-neu', subdomain: 'kunde1-neu' });
    const metaKey = (objectKey: string) => objectKey.replace(/\.dump\.age$/, '.meta.json');

    it('ausgetauschte Uploads samt angepasster Meta-Datei: Abbruch vor jeder Aenderung', async () => {
      const b = await job({ kind: 'backup', instance: instance() });
      const uploadsSha256 = h.control.reports[0]!.uploadsSha256;
      const upKey = b.result.objectKey.replace(/\.dump\.age$/, '.uploads.tar.age');
      const fake = Buffer.from('FREMDE-UPLOADS');
      h.storage.objects.get(upKey)!.data = fake;
      const mk = metaKey(b.result.objectKey);
      const meta = JSON.parse(h.storage.objects.get(mk)!.data.toString());
      const e = meta.files.find((f: { name: string }) => f.name.endsWith('.uploads.tar.age'));
      e.sizeBytes = fake.length;
      e.sha256 = createHash('sha256').update(fake).digest('hex');
      h.storage.objects.get(mk)!.data = Buffer.from(JSON.stringify(meta));
      h.docker.calls.length = 0;
      const r = await job({ kind: 'restore', objectKey: b.result.objectKey, sha256: b.result.sha256, uploadsSha256, ageIdentity: identity, target: target() });
      expect(r.status).toBe('failed');
      expect(r.message).toMatch(/Uploads/);
      expect(h.docker.calls.some((c) => c.startsWith('stop:') || c.includes('pg_restore'))).toBe(false);
      expect(h.docker.containers.find((c) => c.id === 'new-web')!.uploads).toBe('LEER');
    });

    it('Altbestand ohne Uploads-Pruefsumme: nur Datenbank, Uploads uebersprungen mit Hinweis', async () => {
      const b = await job({ kind: 'backup', instance: instance() });
      const r = await job({ kind: 'restore', objectKey: b.result.objectKey, sha256: b.result.sha256, ageIdentity: identity, target: target() });
      expect(r.status).toBe('succeeded');
      expect(r.result.note).toMatch(/Uploads NICHT eingespielt/);
      expect(h.docker.containers.find((c) => c.id === 'new-db')!.db).toBe('DUMP-INHALT-KUNDE1');
      expect(h.docker.containers.find((c) => c.id === 'new-web')!.uploads).toBe('LEER');
    });

    it('Sicherung ohne Uploads-Archiv und ohne Pruefsumme: normal, kein Hinweis', async () => {
      const b = await job({ kind: 'backup', instance: instance({ uploadsService: undefined, uploadsPath: undefined }) });
      expect(h.control.reports[0]!.uploadsSha256).toBeUndefined();
      const r = await job({ kind: 'restore', objectKey: b.result.objectKey, sha256: b.result.sha256, ageIdentity: identity, target: target() });
      expect(r.status).toBe('succeeded');
      expect(r.result.note).toBeUndefined();
    });
  });

  it('backup-control sichert DB und Rechnungsarchiv, Archiv mit Object Lock, unveraenderte Jahre werden nicht doppelt abgelegt', async () => {
    await h.call('PUT', '/v1/target', s3Body({ objectLock: true }));
    h.invoices.docs = { '2026': [{ number: 'RE-2026-0001', pdf: Buffer.from('%PDF-1'), xml: Buffer.from('<xml/>'), xrechnung: null }] };
    const j = await job({ kind: 'backup-control' });
    expect(j.status).toBe('succeeded');
    const keys = [...h.storage.objects.keys()];
    const tarKey = keys.find((k) => /saas\/invoices\/2026\/.*\.tar\.age$/.test(k))!;
    expect(tarKey).toBeTruthy();
    expect(keys.some((k) => /saas\/control\/.*\.dump\.age$/.test(k))).toBe(true);
    const lock = h.storage.objects.get(tarKey)!.retainUntil!;
    expect(lock.getUTCFullYear()).toBeGreaterThanOrEqual(2036);
    const files = parseTar(await decryptBuffer(identity, h.storage.objects.get(tarKey)!.data));
    expect(files.map((f) => f.name)).toEqual(['invoices/2026/RE-2026-0001.pdf', 'invoices/2026/RE-2026-0001.xml', 'hashes.sha256']);
    expect(files[2]!.data.toString()).toContain('invoices/2026/RE-2026-0001.pdf');
    expect(h.control.reports.map((x) => x.kind).sort()).toEqual(['control', 'invoices']);

    h.clock.now = new Date('2026-11-16T02:30:00Z');
    await job({ kind: 'backup-control' });
    expect([...h.storage.objects.keys()].filter((k) => k.includes('/invoices/2026/') && k.endsWith('.tar.age')).length).toBe(1);

    // Neue Rechnung => neues Archiv
    h.invoices.docs['2026']!.push({ number: 'RE-2026-0002', pdf: Buffer.from('%PDF-2') });
    h.clock.now = new Date('2026-11-17T02:30:00Z');
    await job({ kind: 'backup-control' });
    expect([...h.storage.objects.keys()].filter((k) => k.includes('/invoices/2026/') && k.endsWith('.tar.age')).length).toBe(2);
  });

  it('Aufraeumen entfernt alte Instanzsaetze, behaelt den neuesten und fasst invoices/* nie an', async () => {
    await h.call('PUT', '/v1/target', s3Body({ retentionDays: 10, objectLock: false }));
    // alter Rechnungsbestand ohne Lock (z.B. Fremdlauf): darf trotzdem nie geloescht werden
    await h.storage.put('saas/invoices/2020/2020-01-01T000000Z.tar.age', Buffer.from('alt'));
    h.clock.now = new Date('2026-10-01T02:30:00Z');
    await job({ kind: 'backup', instance: instance() });
    h.clock.now = new Date('2026-10-20T02:30:00Z');
    await job({ kind: 'backup', instance: instance() });
    h.clock.now = new Date('2026-11-15T02:30:00Z');
    const last = await job({ kind: 'backup', instance: instance() });
    const inst = [...h.storage.objects.keys()].filter((k) => k.includes('/instances/'));
    expect(inst.some((k) => k.includes('2026-10-01'))).toBe(false);
    expect(inst.some((k) => k.includes('2026-10-20'))).toBe(false);
    expect(inst.some((k) => k.includes('2026-11-15'))).toBe(true);
    expect(last.status).toBe('succeeded');
    expect(h.storage.objects.has('saas/invoices/2020/2020-01-01T000000Z.tar.age')).toBe(true);
    expect(h.storage.deleted.some((k) => k.includes('invoices/'))).toBe(false);
  });

  it('der Delete-Wrapper verweigert invoices/* grundsaetzlich', async () => {
    const { withDeleteGuard } = await import('../src/storage/guard.js');
    const { FakeStorage } = await import('../src/storage/fake.js');
    const s = new FakeStorage();
    await s.put('x/invoices/2024/a.tar.age', Buffer.from('1'));
    await expect(withDeleteGuard(s).delete('x/invoices/2024/a.tar.age')).rejects.toThrow();
    expect(s.objects.size).toBe(1);
  });

  it('Jobs laufen nacheinander, nicht parallel', async () => {
    const ids = await Promise.all([1, 2, 3].map(() => h.call('POST', '/v1/jobs', { kind: 'backup', instance: instance() })));
    await h.app.queue.whenIdle();
    const recs = ids.map((i) => h.app.queue.get(i.json.jobId)!);
    expect(recs.every((r) => r.status === 'succeeded')).toBe(true);
  });

  it('lehnt ungueltige Job-Bodies ab', async () => {
    expect((await h.call('POST', '/v1/jobs', { kind: 'nope' })).status).toBe(400);
    expect((await h.call('POST', '/v1/jobs', { kind: 'backup', instance: { ...instance(), dbName: 'a; rm -rf /' } })).status).toBe(400);
    expect((await h.call('POST', '/v1/jobs', { kind: 'verify', objectKey: '../etc/passwd' })).status).toBe(400);
    expect((await h.call('POST', '/v1/jobs', { kind: 'restore', objectKey: 'a', ageIdentity: 'x', target: instance() })).status).toBe(400);
    expect((await h.call('GET', '/v1/jobs/unbekannt')).status).toBe(404);
  });

  it('Planer holt den Plan, reiht Jobs ein und laeuft je Slot einmal', async () => {
    h.control.plan = [instance()];
    const t = new Date(2026, 10, 15, 2, 30, 5);
    expect(await h.app.scheduler.tick(t)).toBe(true);
    expect(await h.app.scheduler.tick(new Date(2026, 10, 15, 2, 30, 40))).toBe(false);
    expect(await h.app.scheduler.tick(new Date(2026, 10, 15, 14, 30, 0))).toBe(false); // daily
    await h.app.queue.whenIdle();
    expect(h.control.reports.some((r) => r.kind === 'instance')).toBe(true);
    expect(h.control.reports.some((r) => r.kind === 'control')).toBe(true);
    await h.call('PUT', '/v1/target', s3Body({ schedule: 'twice_daily' }));
    expect(await h.app.scheduler.tick(new Date(2026, 10, 15, 14, 30, 0))).toBe(true);
    await h.app.queue.whenIdle();
  });
});
