import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { createApp, type App } from '../src/app.js';
import { ResilientControlClient } from '../src/control-cache.js';
import type { BackupReport, ControlClient, InvoiceArchivePage } from '../src/control-client.js';
import type { ContainerRef, DockerClient, ExecHandle } from '../src/docker/types.js';
import { signRequest } from '../src/hmac.js';
import type { InvoiceDoc, InvoiceSource } from '../src/jobs/context.js';
import { Redactor, createLogger } from '../src/log.js';
import { StateStore } from '../src/state.js';
import { FakeStorage } from '../src/storage/fake.js';
import { withDeleteGuard } from '../src/storage/guard.js';
import type { InstanceSpec } from '../src/types.js';

export const SECRET = 'test-agent-secret-0123456789abcdef0123456789';
export const STATE_KEY = 'test-state-key-0123456789abcdef0123456789ab';
export const S3_SECRET = 'S3-SECRET-ACCESS-KEY-very-secret-value';
export const S3_KEY_ID = 'AKIATESTACCESSKEYID';

export interface FakeContainer extends ContainerRef {
  db?: string; // Inhalt der "Datenbank" (Klartext-Dump)
  uploads?: string;
  /** Anzahl Nutzerobjekte in der "Datenbank" (psql-Pruefung vor der Wiederherstellung). */
  tables?: number;
  /** Erzwingt die Ausgabe der psql-Pruefung (z. B. nicht numerisch). */
  psqlOut?: string;
}

/** Fake-Docker: pg_dump liefert den Dump-Text, pg_restore schreibt ihn zurueck. */
export class FakeDocker implements DockerClient {
  containers: FakeContainer[] = [];
  calls: string[] = [];
  own: string | null = 'saas-instant-main';
  failRestore = false;

  add(c: FakeContainer): FakeContainer {
    this.containers.push(c);
    return c;
  }

  async findContainer(project: string, service: string) {
    return this.containers.find((c) => c.project === project && c.service === service) ?? null;
  }
  async listProject(project: string) {
    return this.containers.filter((c) => c.project === project);
  }
  async ownProject() {
    return this.own;
  }
  async start(id: string) {
    this.calls.push(`start:${id}`);
    this.containers.find((c) => c.id === id)!.running = true;
  }
  async stop(id: string) {
    this.calls.push(`stop:${id}`);
    this.containers.find((c) => c.id === id)!.running = false;
  }
  exec(id: string, cmd: string[], opts?: { stdin?: Readable }): ExecHandle {
    const c = this.containers.find((x) => x.id === id)!;
    this.calls.push(`exec:${id}:${cmd[0]}`);
    const stdout = new PassThrough();
    const done = (async () => {
      if (cmd[0] === 'pg_dump') {
        stdout.end(Buffer.from(c.db ?? ''));
        return { exitCode: 0, stderr: '' };
      }
      if (cmd[0] === 'tar' && cmd[1] === 'czf') {
        stdout.end(Buffer.from(c.uploads ?? ''));
        return { exitCode: 0, stderr: '' };
      }
      if (cmd[0] === 'psql') {
        stdout.end(c.psqlOut ?? `${c.tables ?? 0}\n`);
        return { exitCode: 0, stderr: '' };
      }
      const chunks: Buffer[] = [];
      for await (const ch of opts!.stdin!) chunks.push(Buffer.from(ch as Uint8Array));
      stdout.end();
      if (cmd[0] === 'pg_restore') {
        if (this.failRestore) return { exitCode: 1, stderr: 'boom password=hunter2' };
        c.db = Buffer.concat(chunks).toString('utf8');
      } else if (cmd[0] === 'tar') c.uploads = Buffer.concat(chunks).toString('utf8');
      return { exitCode: 0, stderr: '' };
    })();
    return { stdout, done };
  }
}

export class FakeControl implements ControlClient {
  reports: BackupReport[] = [];
  plan: InstanceSpec[] = [];
  retentionYears: number | undefined = undefined;
  /** Setzt einen Fehler, den getPlan bzw. report wirft (z. B. ControlLockedError). */
  planError: Error | null = null;
  reportError: Error | null = null;
  async getPlan() {
    if (this.planError) throw this.planError;
    return { ...(this.retentionYears !== undefined ? { retentionYears: this.retentionYears } : {}), instances: this.plan };
  }
  async getInvoiceArchivePage(): Promise<InvoiceArchivePage> {
    return { items: [], next: null };
  }
  async report(e: BackupReport) {
    if (this.reportError) throw this.reportError;
    this.reports.push(e);
  }
}

export class FakeInvoices implements InvoiceSource {
  constructor(public docs: Record<string, InvoiceDoc[]> = {}) {}
  /** Setzt ein Fehlerobjekt, das fetchAll wirft (z. B. ControlLockedError). */
  failWith: Error | null = null;
  async fetchAll() {
    if (this.failWith) throw this.failWith;
    return new Map(Object.entries(this.docs));
  }
}

export interface Harness {
  app: App;
  base: string;
  docker: FakeDocker;
  storage: FakeStorage;
  control: FakeControl;
  invoices: FakeInvoices;
  logs: string[];
  clock: { now: Date };
  call(method: string, path: string, body?: unknown, opts?: { headers?: Record<string, string>; secret?: string }): Promise<{ status: number; json: any; text: string }>;
  waitJob(id: string): Promise<any>;
  close(): Promise<void>;
}

export const BOX_PASSWORD = 'BOX-PASSWORD-very-secret-value';
export const BOX_FP = 'SHA256:' + 'A'.repeat(43);

export function boxBody(extra: Record<string, unknown> = {}, box: Record<string, unknown> = {}) {
  return {
    type: 'storagebox',
    schedule: 'daily',
    retentionDays: 30,
    objectLock: false,
    storagebox: { host: 'u1.your-storagebox.de', port: 23, username: 'u1', path: '/bkp', authType: 'password', password: BOX_PASSWORD, ...box },
    ...extra,
  };
}

export function s3Body(extra: Record<string, unknown> = {}) {
  return {
    type: 's3',
    schedule: 'daily',
    retentionDays: 30,
    objectLock: false,
    s3: { endpoint: 'https://s3.example.com', region: 'eu-central-1', bucket: 'bkp', prefix: 'saas', pathStyle: true, accessKeyId: S3_KEY_ID, secretAccessKey: S3_SECRET },
    ...extra,
  };
}

export async function startHarness(
  opts: { storage?: FakeStorage; resilient?: boolean; jobTimeoutMs?: number; deniedProjects?: string[] } = {},
): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'bkp-agent-'));
  const docker = new FakeDocker();
  const clock = { now: new Date('2026-11-15T02:30:00Z') };
  const storage = opts.storage ?? new FakeStorage(() => clock.now);
  const control = new FakeControl();
  const invoices = new FakeInvoices();
  const logs: string[] = [];
  const redactor = new Redactor();
  redactor.add(SECRET);
  const log = createLogger(redactor, (l) => logs.push(l));
  const store = new StateStore(path.join(dir, 'state'), STATE_KEY);
  const app = await createApp({
    ...(opts.jobTimeoutMs ? { jobTimeoutMs: opts.jobTimeoutMs } : {}),
    ...(opts.deniedProjects ? { deniedProjects: opts.deniedProjects } : {}),
    secret: SECRET,
    version: 'test',
    workDir: path.join(dir, 'work'),
    invoiceRetentionYears: 10,
    extraOwnProjects: [],
    docker,
    control: opts.resilient ? new ResilientControlClient(control, store, log, redactor, () => clock.now) : control,
    store,
    storageFactory: () => withDeleteGuard(storage),
    redactor,
    log,
    controlDump: () => {
      const stdout = new PassThrough();
      stdout.end(Buffer.from('CONTROL-DB-DUMP'));
      return { stdout, done: Promise.resolve({ exitCode: 0, stderr: '' }) };
    },
    invoices: () => invoices,
    now: () => clock.now,
  });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const port = (app.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const call: Harness['call'] = async (method, p, body, opts) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const headers = { ...signRequest(opts?.secret ?? SECRET, method, p, raw, Date.now()), ...(opts?.headers ?? {}) };
    const r = await fetch(base + p, { method, headers: { ...headers, ...(raw ? { 'content-type': 'application/json' } : {}) }, body: raw || undefined });
    const text = await r.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: r.status, json, text };
  };

  return {
    app, base, docker, storage, control, invoices, logs, clock, call,
    async waitJob(id) {
      await app.queue.whenIdle();
      return app.queue.get(id);
    },
    close: () => new Promise<void>((r) => app.server.close(() => r())),
  };
}

export const instance = (over: Partial<InstanceSpec> = {}): InstanceSpec => ({
  subdomain: 'kunde1',
  composeProject: 'coolify-kunde1',
  dbService: 'db',
  dbName: 'app',
  dbUser: 'app',
  uploadsService: 'web',
  uploadsPath: '/data/uploads',
  ...over,
});
