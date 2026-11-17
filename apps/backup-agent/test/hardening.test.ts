import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newKeyPair } from '../src/age.js';
import { ResilientControlClient } from '../src/control-cache.js';
import { HttpControlClient, type ControlClient } from '../src/control-client.js';
import { ControlHttpError, ControlLockedError } from '../src/errors.js';
import { JobQueue } from '../src/jobs/queue.js';
import { Redactor, createLogger } from '../src/log.js';
import { StateStore } from '../src/state.js';
import { FakeStorage } from '../src/storage/fake.js';
import { Scheduler } from '../src/scheduler.js';
import { parseTarget, ValidationError } from '../src/validate.js';
import { BOX_FP, BOX_PASSWORD, FakeControl, S3_KEY_ID, S3_SECRET, STATE_KEY, boxBody, instance, s3Body, startHarness, type Harness } from './helpers.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function backupAndIdentity(opts: Parameters<typeof startHarness>[0] = {}) {
  h = await startHarness(opts);
  const r = await h.call('PUT', '/v1/target', s3Body());
  const identity: string = r.json.ageIdentity;
  h.docker.add({ id: 'src-db', project: 'coolify-kunde1', service: 'db', running: true, db: 'DUMP-KUNDE1' });
  h.docker.add({ id: 'src-web', project: 'coolify-kunde1', service: 'web', running: true, uploads: 'UP-KUNDE1' });
  h.docker.add({ id: 'new-db', project: 'coolify-neu', service: 'db', running: true, db: 'LEER' });
  h.docker.add({ id: 'new-web', project: 'coolify-neu', service: 'web', running: true, uploads: 'LEER' });
  const r1 = await h.call('POST', '/v1/jobs', { kind: 'backup', instance: instance() });
  const b = await h.waitJob(r1.json.jobId);
  expect(b.status).toBe('succeeded');
  return { identity, backup: b };
}

async function restore(body: Record<string, unknown>) {
  const r = await h!.call('POST', '/v1/jobs', { kind: 'restore', ...body });
  expect(r.status).toBe(202);
  return h!.waitJob(r.json.jobId);
}

describe('M4: Restore nur mit passendem Schluessel und nur in neue Stacks', () => {
  it('fremder age-Schluessel (auch wenn die Sicherung damit verschluesselt waere) wird abgewiesen, Ziel unberuehrt', async () => {
    const { backup } = await backupAndIdentity();
    const other = await newKeyPair();
    h!.docker.calls.length = 0;
    const j = await restore({ objectKey: backup.result.objectKey, sha256: backup.result.sha256, ageIdentity: other.identity, target: instance({ composeProject: 'coolify-neu' }) });
    expect(j.status).toBe('failed');
    expect(j.message).toMatch(/gehoert nicht zu diesem Sicherungsziel/);
    expect(h!.docker.calls).toEqual([]);
  });

  it('laufende Instanz laut Sicherungsplan ist kein Ziel', async () => {
    const { identity, backup } = await backupAndIdentity();
    h!.control.plan = [instance({ composeProject: 'coolify-neu', subdomain: 'neu' })];
    const j = await restore({ objectKey: backup.result.objectKey, sha256: backup.result.sha256, ageIdentity: identity, target: instance({ composeProject: 'coolify-neu' }) });
    expect(j.status).toBe('failed');
    expect(j.message).toMatch(/laufende Instanz/);
    expect(h!.docker.containers.find((c) => c.id === 'new-db')!.db).toBe('LEER');
  });

  it('ohne Plan (Verwaltung gesperrt, nichts gemerkt) wird abgelehnt (fail closed)', async () => {
    const { identity, backup } = await backupAndIdentity();
    h!.control.planError = new ControlLockedError();
    const j = await restore({ objectKey: backup.result.objectKey, sha256: backup.result.sha256, ageIdentity: identity, target: instance({ composeProject: 'coolify-neu' }) });
    expect(j.status).toBe('failed');
    expect(j.message).toMatch(/Sicherungsplan nicht verfuegbar/);
  });

  it('Sperrliste: Verwaltungs-, Portal- und portal-auth-Projekte (Vorgabe saas-instant-*) sowie Betreiber-Eintraege', async () => {
    const { identity, backup } = await backupAndIdentity({ deniedProjects: ['mein-portal', 'eigene-*'] });
    for (const project of ['saas-instant-portal', 'saas-instant-alpha', 'mein-portal', 'eigene-verwaltung']) {
      h!.docker.add({ id: `x-${project}`, project, service: 'db', running: true, db: 'GESCHUETZT' });
      const j = await restore({ objectKey: backup.result.objectKey, sha256: backup.result.sha256, ageIdentity: identity, target: instance({ composeProject: project }) });
      expect(j.status, project).toBe('failed');
      expect(j.message).toMatch(/Sperrliste/);
      expect(h!.docker.containers.find((c) => c.id === `x-${project}`)!.db).toBe('GESCHUETZT');
    }
  });

  it('Normalfall: neuer Stack, richtiger Schluessel, passende Pruefsumme', async () => {
    const { identity, backup } = await backupAndIdentity();
    const j = await restore({ objectKey: backup.result.objectKey, sha256: backup.result.sha256, ageIdentity: identity, target: instance({ composeProject: 'coolify-neu' }) });
    expect(j.status).toBe('succeeded');
    expect(h!.docker.containers.find((c) => c.id === 'new-db')!.db).toBe('DUMP-KUNDE1');
  });
});

describe('M5: Echtheit der Sicherung ueber die Pruefsumme der Verwaltung', () => {
  it('abweichende Pruefsumme: Abbruch vor dem Herunterladen und Entschluesseln, Ziel unberuehrt', async () => {
    const { identity, backup } = await backupAndIdentity();
    h!.docker.calls.length = 0;
    const j = await restore({ objectKey: backup.result.objectKey, sha256: 'a'.repeat(64), ageIdentity: identity, target: instance({ composeProject: 'coolify-neu' }) });
    expect(j.status).toBe('failed');
    expect(j.message).toMatch(/Pruefsumme der Sicherung weicht von der Angabe der Verwaltung ab/);
    expect(h!.docker.calls).toEqual([]);
  });

  it('Speicher samt Meta-Datei ausgetauscht (selbst konsistent): die gemeldete Pruefsumme entlarvt es', async () => {
    const { identity, backup } = await backupAndIdentity();
    const key: string = backup.result.objectKey;
    const metaKey = key.replace('.dump.age', '.meta.json');
    const forged = Buffer.from('anderes-chiffrat');
    const { sha256hex } = await import('../src/hmac.js');
    h!.storage.objects.get(key)!.data = forged;
    h!.storage.objects.set(metaKey, { data: Buffer.from(JSON.stringify({ version: 1, kind: 'instance', files: [{ name: key.split('/').pop(), sizeBytes: forged.length, sha256: sha256hex(forged) }] })), modified: new Date() });
    const j = await restore({ objectKey: key, sha256: backup.result.sha256, ageIdentity: identity, target: instance({ composeProject: 'coolify-neu' }) });
    expect(j.status).toBe('failed');
    expect(j.message).toMatch(/weicht von der Angabe der Verwaltung ab/);
  });

  it('ohne sha256 im Auftrag: 400', async () => {
    const { identity, backup } = await backupAndIdentity();
    const r = await h!.call('POST', '/v1/jobs', { kind: 'restore', objectKey: backup.result.objectKey, ageIdentity: identity, target: instance({ composeProject: 'coolify-neu' }) });
    expect(r.status).toBe(400);
  });
});

describe('M6: SFTP nur mit gepinntem Host-Key (ausser im Verbindungstest)', () => {
  it('parseTarget nimmt einen eingegebenen Fingerabdruck an und lehnt Ungueltiges ab', () => {
    expect(parseTarget(boxBody({}, { hostKeyFingerprint: BOX_FP })).storagebox!.hostKeyFingerprint).toBe(BOX_FP);
    expect(() => parseTarget(boxBody({}, { hostKeyFingerprint: 'MD5:abc' }))).toThrow(ValidationError);
  });

  it('Verbindungstest nutzt eine eigene TOFU-Sicht des Speichers', async () => {
    const calls: string[] = [];
    const storage = new FakeStorage();
    (storage as unknown as { withTofu: () => FakeStorage }).withTofu = () => {
      calls.push('tofu');
      return storage;
    };
    h = await startHarness({ storage });
    await h.call('PUT', '/v1/target', s3Body());
    const r = await h.call('POST', '/v1/target/test');
    expect(r.json.ok).toBe(true);
    expect(calls).toEqual(['tofu']);
  });
});

describe('M7: gespeicherte Geheimnisse nur bei unveraenderter Gegenstelle', () => {
  const existing = () => parseTarget(boxBody({}, { hostKeyFingerprint: BOX_FP }));
  const without = (box: Record<string, unknown>, drop: string[] = ['password']) => {
    const b: any = boxBody({}, box);
    for (const d of drop) delete b.storagebox[d];
    return b;
  };

  it('Host, Port oder Benutzer geaendert, Passwort weggelassen: Pflichtfeld-Fehler', () => {
    for (const change of [{ host: 'attacker.example' }, { port: 2222 }, { username: 'anderer' }]) {
      expect(() => parseTarget(without(change), existing())).toThrow(/Gib das Passwort erneut ein/);
    }
  });

  it('unveraendert: Passwort bleibt', () => {
    expect(parseTarget(without({}), existing()).storagebox!.password).toBe(BOX_PASSWORD);
  });

  it('mit neu eingegebenem Passwort darf der Host wechseln (neues TOFU, Pin faellt weg)', () => {
    const t = parseTarget(boxBody({}, { host: 'neu.example', password: 'neues-passwort' }), existing());
    expect(t.storagebox!.password).toBe('neues-passwort');
    expect(t.storagebox!.hostKeyFingerprint).toBeUndefined();
  });

  it('S3: Endpunkt, Bucket oder Zugangskennung geaendert ohne Geheimnis: Fehler; unveraendert: bleibt', () => {
    const old = parseTarget(s3Body());
    const keep = (s3: Record<string, unknown>, drop: string[]) => {
      const b: any = s3Body();
      Object.assign(b.s3, s3);
      for (const d of drop) delete b.s3[d];
      return b;
    };
    expect(parseTarget(keep({}, ['accessKeyId', 'secretAccessKey']), old).s3!.secretAccessKey).toBe(S3_SECRET);
    expect(() => parseTarget(keep({ endpoint: 'https://evil.example' }, ['accessKeyId', 'secretAccessKey']), old)).toThrow(/erneut ein/);
    expect(() => parseTarget(keep({ bucket: 'anderer' }, ['accessKeyId', 'secretAccessKey']), old)).toThrow(/erneut ein/);
    // neue Kennung ohne neues Geheimnis wird nicht mit dem alten gepaart
    expect(() => parseTarget(keep({ accessKeyId: 'NEUEKENNUNG1' }, ['secretAccessKey']), old)).toThrow(/Zugangsschluessel erneut/);
    expect(parseTarget(keep({}, ['secretAccessKey']), old).s3!.accessKeyId).toBe(S3_KEY_ID);
  });
});

describe('M8: Jobs hinterlassen Logzeilen und haben ein Zeitlimit', () => {
  it('fehlgeschlagener geplanter Lauf wird mit Meldung geloggt', async () => {
    h = await startHarness();
    await h.call('PUT', '/v1/target', s3Body());
    h.control.plan = [instance()]; // DB-Container fehlt
    await h.app.scheduler.runAll();
    await h.app.queue.whenIdle();
    const line = h.logs.find((l) => l.includes('Auftrag fehlgeschlagen'));
    expect(line).toBeDefined();
    expect(line).toMatch(/Datenbank-Container der Instanz nicht gefunden/);
    expect(line).toMatch(/"kind":"backup"/);
  });

  it('Zeitlimit: Auftrag scheitert mit Meldung, Signal wird ausgeloest, der naechste Auftrag laeuft', async () => {
    const logs: string[] = [];
    const redactor = new Redactor();
    const q = new JobQueue(redactor, () => new Date(), { timeoutMs: 40, log: createLogger(redactor, (l) => logs.push(l)) });
    let aborted = false;
    const hang = q.submit('backup', (signal) => new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('abgebrochen'));
      });
    }));
    const ok = q.submit('verify', async () => ({ objectKey: 'x' }));
    await q.whenIdle();
    expect(q.get(hang)!.status).toBe('failed');
    expect(q.get(hang)!.message).toMatch(/Zeitlimit/);
    expect(aborted).toBe(true);
    expect(q.get(ok)!.status).toBe('succeeded');
    expect(logs.some((l) => l.includes('Zeitlimit'))).toBe(true);
  });
});

describe('Zeitlimit ohne Ueberlappung', () => {
  it('der naechste Auftrag startet erst, wenn der abgebrochene Lauf wirklich beendet ist', async () => {
    const redactor = new Redactor();
    const q = new JobQueue(redactor, () => new Date(), { timeoutMs: 20, graceMs: 2_000, log: createLogger(redactor, () => undefined) });
    let firstEnded = false;
    let overlap = false;
    q.submit('backup', (signal) => new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => setTimeout(() => {
        firstEnded = true;
        reject(new Error('abgebrochen'));
      }, 80));
    }));
    const second = q.submit('verify', async () => {
      overlap = !firstEnded;
      return { objectKey: 'x' };
    });
    await q.whenIdle();
    expect(overlap).toBe(false);
    expect(q.get(second)!.status).toBe('succeeded');
  });

  it('endet der abgebrochene Lauf nicht innerhalb der Frist: blockiert, Logzeile, kein neuer Auftrag; danach geht es weiter', async () => {
    const logs: string[] = [];
    const redactor = new Redactor();
    const q = new JobQueue(redactor, () => new Date(), { timeoutMs: 20, graceMs: 30, log: createLogger(redactor, (l) => logs.push(l)) });
    let release: () => void = () => undefined;
    q.submit('backup', () => new Promise<never>((_, reject) => { release = () => reject(new Error('endlich')); }));
    let started = false;
    const second = q.submit('verify', async () => {
      started = true;
      return {};
    });
    await vi.waitFor(() => expect(q.isBlocked()).toBe(true));
    expect(q.hasActive()).toBe(true);
    let idled = false;
    void q.whenIdle().then(() => { idled = true; });
    await Promise.resolve();
    expect(idled).toBe(false); // wartet auf den Zombie-Lauf
    expect(started).toBe(false);
    expect(q.get(second)!.status).toBe('queued');
    expect(logs.some((l) => l.includes('endet nicht'))).toBe(true);
    release();
    await q.whenIdle();
    expect(q.isBlocked()).toBe(false);
    expect(started).toBe(true);
  });
});

describe('Vorhaltedatei', () => {
  it('eine waehrend flush eingereihte Meldung bleibt erhalten', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bkp-cache-'));
    const redactor = new Redactor();
    const log = createLogger(redactor, () => undefined);
    let gate: () => void = () => undefined;
    const held = new Promise<void>((r) => { gate = r; });
    let enter: () => void = () => undefined;
    const entered = new Promise<void>((r) => { enter = r; });
    const sent: string[] = [];
    let lockedMode = true;
    const inner = {
      getPlan: async () => ({ instances: [] }),
      getInvoiceArchivePage: async () => ({ items: [], next: null }),
      report: async (e: { objectKey?: string }) => {
        if (lockedMode) throw new ControlLockedError();
        if (e.objectKey === 'k1') {
          enter();
          await held; // flush haengt hier
        }
        sent.push(e.objectKey ?? '');
      },
    } as unknown as ControlClient;
    const c = new ResilientControlClient(inner, new StateStore(dir, STATE_KEY), log, redactor);
    await c.report({ kind: 'control', date: '2026-11-15', sizeBytes: 5, objectKey: 'k1', sha256: 'a'.repeat(64) });
    lockedMode = false;
    const flushing = c.flush();
    await entered;
    // waehrend flush: neue Meldung, die nicht zugestellt werden kann
    lockedMode = true;
    await c.report({ kind: 'control', date: '2026-11-16', sizeBytes: 6, objectKey: 'k2', sha256: 'b'.repeat(64) });
    lockedMode = false;
    gate();
    await flushing;
    expect(sent).toEqual(['k1']);
    await c.flush();
    expect(sent).toEqual(['k1', 'k2']);
  });

  it('Fallback auf den gespeicherten Plan: die Loeschliste ist leer', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bkp-cache-'));
    const redactor = new Redactor();
    const log = createLogger(redactor, () => undefined);
    let down = false;
    const inner = {
      getPlan: async () => {
        if (down) throw new ControlLockedError();
        return { instances: [], purge: ['kunde1'] };
      },
    } as unknown as ControlClient;
    const c = new ResilientControlClient(inner, new StateStore(dir, STATE_KEY), log, redactor);
    expect((await c.getPlan()).purge).toEqual(['kunde1']);
    down = true;
    expect((await c.getPlan()).purge ?? []).toEqual([]);
  });

  it('Speicherfehler beim Zusammenfuehren der Vorhaltedatei wird als Warnung geloggt', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bkp-cache-'));
    const redactor = new Redactor();
    const lines: string[] = [];
    const log = createLogger(redactor, (l) => lines.push(l));
    let locked = true;
    const inner = {
      getPlan: async () => ({ instances: [] }),
      getInvoiceArchivePage: async () => ({ items: [], next: null }),
      report: async () => {
        if (locked) throw new ControlLockedError();
      },
    } as unknown as ControlClient;
    const store = new StateStore(dir, STATE_KEY);
    const c = new ResilientControlClient(inner, store, log, redactor);
    await c.report({ kind: 'control', date: '2026-11-15', sizeBytes: 5, objectKey: 'k1', sha256: 'a'.repeat(64) });
    locked = false;
    store.saveAux = async () => { throw new Error('platte voll'); };
    await c.flush();
    expect(lines.some((l) => l.includes('Vorhaltedatei konnte nicht aktualisiert werden') && l.includes('platte voll'))).toBe(true);
  });
});

describe('N9', () => {
  it('(a) Lauf ohne neue Rechnungsdateien wird trotzdem als Lauf gemeldet; ohne Rechnungen ebenso', async () => {
    h = await startHarness();
    await h.call('PUT', '/v1/target', s3Body());
    const run = async () => h!.waitJob((await h!.call('POST', '/v1/jobs', { kind: 'backup-control' })).json.jobId);
    await run(); // leer
    expect(h.control.reports.filter((r) => r.kind === 'invoices')).toEqual([expect.objectContaining({ sizeBytes: 0 })]);
    h.invoices.docs = { '2026': [{ number: 'RE-1', pdf: Buffer.from('PDF') }] };
    await run(); // neu
    const created = h.control.reports.filter((r) => r.kind === 'invoices').at(-1)!;
    expect(created.objectKey).toMatch(/invoices\/2026\//);
    h.clock.now = new Date(h.clock.now.getTime() + 86_400_000);
    h.control.reports.length = 0;
    await run(); // unveraendert
    const again = h.control.reports.filter((r) => r.kind === 'invoices');
    expect(again).toEqual([expect.objectContaining({ objectKey: created.objectKey, sha256: created.sha256, date: '2026-11-16' })]);
    expect([...h.storage.objects.keys()].filter((k) => /invoices\/2026\/.*\.tar\.age$/.test(k))).toHaveLength(1);
  });

  it('(b) 429: wartet Retry-After und versucht erneut; gibt nach den Versuchen auf', async () => {
    const waits: number[] = [];
    let n = 0;
    const mk = (limit: number) =>
      new HttpControlClient('http://c', 'k', (async () => {
        n++;
        if (n <= limit) return { ok: false, status: 429, headers: new Headers({ 'retry-after': '3' }), json: async () => ({}) };
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({ items: [], next: null }) };
      }) as unknown as typeof fetch, { sleep: async (ms) => void waits.push(ms) });
    expect(await mk(2).getInvoiceArchivePage()).toEqual({ items: [], next: null });
    expect(waits).toEqual([3000, 3000]);
    n = 0;
    await expect(mk(99).getInvoiceArchivePage()).rejects.toThrow(/HTTP 429/);
  });

  it('(c) verpasster Slot (Zeitumstellung) wird beim naechsten Tick nachgeholt, nur einmal; ein Neustart loest nichts aus', async () => {
    let runs = 0;
    const s = new Scheduler({
      control: new FakeControl(),
      schedule: () => 'daily',
      enqueueInstance: () => undefined,
      enqueueControl: () => void runs++,
      log: createLogger(new Redactor(), () => undefined),
      redactor: new Redactor(),
    });
    expect(await s.tick(new Date(2026, 10, 15, 2, 29, 30))).toBe(false); // vor dem Slot
    // Die Uhr springt (Zeitumstellung, Stillstand des Prozesses): 02:30:00 wird nie als Tick gesehen
    expect(await s.tick(new Date(2026, 10, 15, 2, 41, 10))).toBe(true);
    expect(await s.tick(new Date(2026, 10, 15, 2, 41, 40))).toBe(false);
    expect(runs).toBe(1);
    // Frischer Agent mitten am Vormittag: der Slot von 02:30 gilt als erledigt, nichts laeuft
    const s2 = new Scheduler({ control: new FakeControl(), schedule: () => 'daily', enqueueInstance: () => undefined, enqueueControl: () => void runs++, log: createLogger(new Redactor(), () => undefined), redactor: new Redactor() });
    expect(await s2.tick(new Date(2026, 10, 15, 10, 0, 0))).toBe(false);
    expect(runs).toBe(1);
  });

  it('(d) ungueltiger Planeintrag wird geloggt, der Rest bleibt', async () => {
    const warns: string[] = [];
    const redactor = new Redactor();
    const log = createLogger(redactor, (l) => warns.push(l));
    const c = new HttpControlClient('http://c', 'k', (async () => ({
      ok: true, status: 200, json: async () => ({ instances: [instance(), { subdomain: 'Kaputt!' }] }),
    })) as unknown as typeof fetch, { log });
    expect((await c.getPlan()).instances).toHaveLength(1);
    expect(warns.some((l) => l.includes('Ungueltiger Eintrag im Sicherungsplan'))).toBe(true);
  });

  it('(e) tar-Fehler bei den Uploads: Dump bleibt, Meta nennt nur den Dump, Lauf gilt als teilweise gescheitert', async () => {
    h = await startHarness();
    const first = await h.call('PUT', '/v1/target', s3Body());
    const identity = first.json.ageIdentity as string;
    h.docker.add({ id: 'src-db', project: 'coolify-kunde1', service: 'db', running: true, db: 'DUMP-KUNDE1' });
    h.docker.add({ id: 'src-web', project: 'coolify-kunde1', service: 'web', running: true, uploads: 'UP' });
    const orig = h.docker.exec.bind(h.docker);
    h.docker.exec = ((id: string, cmd: string[], o?: any) => {
      if (cmd[0] === 'tar') {
        const done = Promise.resolve({ exitCode: 2, stderr: 'tar: boom' });
        return { stdout: Readable.from([]), done };
      }
      return orig(id, cmd, o);
    }) as never;
    const r = await h.call('POST', '/v1/jobs', { kind: 'backup', instance: instance() });
    const j = await h.waitJob(r.json.jobId);
    expect(j.status).toBe('failed');
    expect(j.message).toMatch(/Teilweise gescheitert/);
    const keys = [...h.storage.objects.keys()];
    expect(keys.some((k) => k.endsWith('.dump.age'))).toBe(true);
    expect(keys.some((k) => k.endsWith('.uploads.tar.age'))).toBe(false);
    const meta = JSON.parse(h.storage.objects.get(keys.find((k) => k.endsWith('.meta.json'))!)!.data.toString());
    expect(meta.partial).toBe(true);
    expect(meta.files).toHaveLength(1);
    expect(h.control.reports.some((x) => x.kind === 'instance')).toBe(true);
    // Der erhaltene Dump laesst sich wiederherstellen (nur DB)
    h.docker.add({ id: 'new-db', project: 'coolify-neu', service: 'db', running: true, db: 'LEER' });
    const dump = keys.find((k) => k.endsWith('.dump.age'))!;
    const rr = await h.call('POST', '/v1/jobs', { kind: 'restore', objectKey: dump, sha256: j.result?.sha256 ?? h.control.reports[0]!.sha256, ageIdentity: identity, target: instance({ composeProject: 'coolify-neu' }) });
    expect((await h.waitJob(rr.json.jobId)).status).toBe('succeeded');
    expect(h.docker.containers.find((c) => c.id === 'new-db')!.db).toBe('DUMP-KUNDE1');
  });
});

describe('Rechnungsarchiv: gleiche bereinigte Namen', () => {
  it('zwei Rechnungsnummern mit demselben bereinigten Dateinamen ueberschreiben sich im Archiv nicht', async () => {
    h = await startHarness();
    const first = await h.call('PUT', '/v1/target', s3Body());
    h.invoices.docs = { '2026': [{ number: 'RE/2026/1', pdf: Buffer.from('PDF-A') }, { number: 'RE_2026_1', pdf: Buffer.from('PDF-B') }] };
    const r = await h.call('POST', '/v1/jobs', { kind: 'backup-control' });
    expect((await h.waitJob(r.json.jobId)).status).toBe('succeeded');
    const k = [...h.storage.objects.keys()].find((x) => x.includes('invoices/') && x.endsWith('.tar.age'))!;
    const { decryptBuffer } = await import('../src/age.js');
    const { parseTar } = await import('../src/tar.js');
    const entries = parseTar(await decryptBuffer(first.json.ageIdentity, h.storage.objects.get(k)!.data));
    const pdfs = entries.filter((e) => e.name.endsWith('.pdf'));
    expect(pdfs.map((e) => e.name).sort()).toEqual(['invoices/2026/RE_2026_1.pdf', 'invoices/2026/RE_2026_1__2.pdf']);
    expect(pdfs.map((e) => e.data.toString()).sort()).toEqual(['PDF-A', 'PDF-B']);
  });
});

describe('Rechnungsarchiv: uebersprungene Belege', () => {
  it('uebersprungene Belege sind ein Fehler: der Rest wird abgelegt, aber kein Erfolg gemeldet', async () => {
    h = await startHarness();
    await h.call('PUT', '/v1/target', s3Body());
    h.invoices.docs = { '2026': [{ number: 'RE-1', pdf: Buffer.from('PDF') }] };
    (h.invoices as unknown as { skipped: () => unknown }).skipped = () => [{ number: 'RE-2', reason: 'undecryptable' }];
    const r = await h.call('POST', '/v1/jobs', { kind: 'backup-control' });
    const j = await h.waitJob(r.json.jobId);
    expect(j.status).toBe('failed');
    expect(j.message).toMatch(/unvollstaendig.*RE-2/);
    expect([...h.storage.objects.keys()].some((k) => /invoices\/2026\/.*\.tar\.age$/.test(k))).toBe(true);
    expect(h.control.reports.filter((x) => x.kind === 'invoices').every((x) => x.sizeBytes > 0)).toBe(true);
    // naechster Lauf ohne uebersprungene Belege: wieder erfolgreich
    (h.invoices as unknown as { skipped: () => unknown }).skipped = () => [];
    const r2 = await h.call('POST', '/v1/jobs', { kind: 'backup-control' });
    expect((await h.waitJob(r2.json.jobId)).status).toBe('succeeded');
  });

  it('die Seite der Verwaltung traegt skipped bis in die Quelle', async () => {
    const { controlInvoiceSource } = await import('../src/invoices-http.js');
    const c = new FakeControl();
    c.getInvoiceArchivePage = async () => ({ items: [], skipped: [{ invoiceId: '1', number: 'RE-9', reason: 'undecryptable' }], next: null });
    const src = controlInvoiceSource(c);
    await src.fetchAll();
    expect(src.skipped!()).toEqual([{ number: 'RE-9', reason: 'undecryptable' }]);
  });
});

describe('H1: gesperrte Verwaltung stoppt die Sicherung nicht', () => {
  it('Plan nicht abrufbar (423): der zuletzt gueltige Plan wird verwendet, mit Warnlog', async () => {
    h = await startHarness({ resilient: true });
    await h.call('PUT', '/v1/target', s3Body());
    h.docker.add({ id: 'src-db', project: 'coolify-kunde1', service: 'db', running: true, db: 'D' });
    h.control.plan = [instance({ uploadsService: undefined, uploadsPath: undefined })];
    await h.app.scheduler.runAll(); // erfolgreich: Plan wird gemerkt
    await h.app.queue.whenIdle();
    const instanceDumps = () => [...h!.storage.objects.keys()].filter((k) => /instances\/kunde1\/.*\.dump\.age$/.test(k)).length;
    expect(instanceDumps()).toBe(1);

    h.clock.now = new Date(h.clock.now.getTime() + 3_600_000);
    h.control.planError = new ControlHttpError(423, 'Sicherungsplan nicht abrufbar (HTTP 423)');
    h.control.plan = [];
    await h.app.scheduler.runAll();
    await h.app.queue.whenIdle();
    expect(instanceDumps()).toBe(2);
    expect(h.logs.some((l) => l.includes('zuletzt gueltige Plan') && l.includes('warn'))).toBe(true);
  });

  it('ohne gemerkten Plan bleibt es beim Fehler (mit lauter Logzeile)', async () => {
    h = await startHarness({ resilient: true });
    await h.call('PUT', '/v1/target', s3Body());
    h.control.planError = new ControlLockedError();
    await h.app.scheduler.runAll();
    await h.app.queue.whenIdle();
    expect(h.logs.some((l) => l.includes('Instanzen werden diesmal NICHT gesichert'))).toBe(true);
  });

  it('Meldungen bei 423 werden zwischengespeichert und spaeter nachgereicht (auch nach Neustart des Agenten)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bkp-cache-'));
    const inner = new FakeControl();
    const redactor = new Redactor();
    const logs: string[] = [];
    const log = createLogger(redactor, (l) => logs.push(l));
    const mk = () => new ResilientControlClient(inner as ControlClient, new StateStore(dir, STATE_KEY), log, redactor);
    inner.reportError = new ControlLockedError();
    await mk().report({ kind: 'control', date: '2026-11-15', sizeBytes: 5, objectKey: 'k1', sha256: 'a'.repeat(64) });
    expect(inner.reports).toHaveLength(0);
    expect(logs.some((l) => l.includes('zwischengespeichert'))).toBe(true);
    // Agent startet neu, Verwaltung ist entsperrt
    inner.reportError = null;
    const fresh = mk();
    await fresh.flush();
    expect(inner.reports.map((r) => r.objectKey)).toEqual(['k1']);
    await fresh.flush();
    expect(inner.reports).toHaveLength(1); // nichts doppelt
  });

  it('abgelehnte Meldung (400) wird nicht ewig vorgehalten, sondern verworfen', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bkp-cache-'));
    const inner = new FakeControl();
    const redactor = new Redactor();
    const c = new ResilientControlClient(inner as ControlClient, new StateStore(dir, STATE_KEY), createLogger(redactor, () => undefined), redactor);
    inner.reportError = new ControlHttpError(400, 'Meldung an die Verwaltung fehlgeschlagen (HTTP 400)');
    await expect(c.report({ kind: 'control', date: '2026-11-15', sizeBytes: 5 })).rejects.toThrow(/400/);
    inner.reportError = null;
    await c.flush();
    expect(inner.reports).toHaveLength(0);
  });
});
