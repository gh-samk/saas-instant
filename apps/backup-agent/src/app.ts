import http from 'node:http';
import { URL } from 'node:url';
import { type ControlClient } from './control-client.js';
import { DeferredError } from './errors.js';
import type { DockerClient, ExecHandle } from './docker/types.js';
import { MAX_BODY_BYTES, NonceStore, verifyRequest } from './hmac.js';
import { type Logger, type Redactor, safeMessage } from './log.js';
import { kindOfKey, dateOfKey, subdomainOfKey } from './keys.js';
import type { JobContext, InvoiceSource } from './jobs/context.js';
import { runBackup } from './jobs/backup.js';
import { runBackupControl } from './jobs/backupControl.js';
import { readMeta } from './jobs/common.js';
import { JobQueue } from './jobs/queue.js';
import { DEFAULT_DENIED_PROJECTS, runRestore } from './jobs/restore.js';
import { runVerify } from './jobs/verify.js';
import { Scheduler } from './scheduler.js';
import type { StorageFactory } from './storage/index.js';
import type { StateStore } from './state.js';
import { TargetService } from './target.js';
import type { BackupKind, BackupListEntry, InstanceSpec, JobKind, JobResult } from './types.js';
import {
  ValidationError,
  isRecord,
  parseAgeIdentity,
  parseInstanceSpec,
  parseObjectKey,
  parseSha256,
  parseSubdomain,
} from './validate.js';

export interface AppDeps {
  secret: string;
  version: string;
  workDir: string;
  invoiceRetentionYears: number;
  extraOwnProjects: string[];
  /** Sperrliste fuer Restore-Ziele (Namen oder Praefixe mit `*`), zusaetzlich zur Vorgabe. */
  deniedProjects?: string[];
  /** Zeitlimit je Auftrag in Millisekunden (Vorgabe 2 Stunden). */
  jobTimeoutMs?: number;
  docker: DockerClient;
  control: ControlClient;
  store: StateStore;
  storageFactory: StorageFactory;
  redactor: Redactor;
  log: Logger;
  controlDump: (signal?: AbortSignal) => ExecHandle;
  invoices: () => InvoiceSource;
  now?: () => Date;
  nonces?: NonceStore;
}

export interface App {
  server: http.Server;
  queue: JobQueue;
  targets: TargetService;
  scheduler: Scheduler;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function createApp(deps: AppDeps): Promise<App> {
  const now = deps.now ?? (() => new Date());
  const nonces = deps.nonces ?? new NonceStore();
  const targets = new TargetService(deps.store, deps.storageFactory, deps.redactor);
  await targets.init();
  const queue = new JobQueue(deps.redactor, now, { timeoutMs: deps.jobTimeoutMs, log: deps.log });
  // Aufbewahrung der Rechnungsarchive: Vorgabe der Verwaltung (Plan), sonst Umgebung.
  let invoiceRetentionYears = deps.invoiceRetentionYears;
  const refreshRetention = async (): Promise<void> => {
    try {
      const plan = await deps.control.getPlan();
      if (plan.retentionYears) invoiceRetentionYears = plan.retentionYears;
    } catch (e) {
      deps.log.warn('Aufbewahrungsfrist nicht aus dem Plan lesbar, Rueckfall gilt', { error: safeMessage(deps.redactor, e) });
    }
  };

  const buildCtx = (signal?: AbortSignal): JobContext => {
    const cur = targets.current();
    if (!cur) throw new Error('Kein Ziel eingerichtet');
    return {
      storage: cur.storage,
      target: cur.target,
      keyPrefix: cur.keyPrefix,
      recipient: cur.recipient,
      docker: deps.docker,
      control: deps.control,
      log: deps.log,
      redactor: deps.redactor,
      workDir: deps.workDir,
      now,
      invoiceRetentionYears,
      controlDump: deps.controlDump,
      invoices: deps.invoices,
      ...(signal ? { signal } : {}),
      deniedProjects: [...DEFAULT_DENIED_PROJECTS, ...(deps.deniedProjects ?? [])],
      ownProjects: async () => {
        const set = new Set(deps.extraOwnProjects);
        const own = await deps.docker.ownProject();
        if (own) set.add(own);
        return set;
      },
    };
  };

  const enqueueBackup = (spec: InstanceSpec) =>
    queue.submit('backup', (signal) => runBackup(buildCtx(signal), spec));
  // Rechnungsarchiv verschoben (Verwaltung gesperrt)? Der Planer versucht es erneut, ohne neuen DB-Dump.
  let invoicesDeferred = false;
  const runControlJob = async (invoicesOnly: boolean, signal?: AbortSignal): Promise<JobResult | void> => {
    await refreshRetention();
    try {
      const r = await runBackupControl(buildCtx(signal), { invoicesOnly });
      invoicesDeferred = false;
      return r;
    } catch (e) {
      if (e instanceof DeferredError) invoicesDeferred = true;
      throw e;
    }
  };
  const enqueueControl = () => queue.submit('backup-control', (signal) => runControlJob(false, signal));
  const enqueueInvoices = () => queue.submit('backup-control', (signal) => runControlJob(true, signal));

  const scheduler = new Scheduler({
    control: deps.control,
    schedule: () => targets.current()?.target.schedule ?? null,
    enqueueInstance: (s) => void enqueueBackup(s),
    enqueueControl: () => void enqueueControl(),
    invoicesDeferred: () => invoicesDeferred && !queue.hasActive(),
    enqueueInvoices: () => void enqueueInvoices(),
    log: deps.log,
    redactor: deps.redactor,
  });

  async function listBackups(kind?: string, subdomain?: string): Promise<BackupListEntry[]> {
    const cur = targets.current();
    if (!cur) throw new HttpError(409, 'Kein Ziel eingerichtet');
    const kinds: BackupKind[] = kind ? [kind as BackupKind] : ['instance', 'control', 'invoices'];
    const prefixes: string[] = [];
    for (const k of kinds) {
      if (k === 'instance') prefixes.push(`${cur.keyPrefix}instances/${subdomain ? subdomain + '/' : ''}`);
      else if (k === 'control') prefixes.push(`${cur.keyPrefix}control/`);
      else prefixes.push(`${cur.keyPrefix}invoices/`);
    }
    const ctx = buildCtx();
    const out: BackupListEntry[] = [];
    for (const p of prefixes) {
      for (const o of await cur.storage.list(p)) {
        const k = kindOfKey(o.key);
        const date = dateOfKey(o.key);
        if (!k || !date || !kinds.includes(k)) continue;
        const meta = await readMeta(ctx, o.key).catch(() => null);
        const name = o.key.split('/').pop()!;
        const sha = meta?.files.find((f) => f.name === name)?.sha256 ?? '';
        const sub = subdomainOfKey(o.key);
        out.push({ objectKey: o.key, kind: k, ...(sub ? { subdomain: sub } : {}), date, sizeBytes: o.size, sha256: sha });
      }
    }
    return out.sort((a, b) => b.objectKey.localeCompare(a.objectKey));
  }

  function submitJob(body: unknown): string {
    if (!isRecord(body)) throw new ValidationError('Body muss ein Objekt sein');
    const kind = body['kind'] as JobKind;
    if (!targets.isConfigured()) throw new HttpError(409, 'Kein Ziel eingerichtet');
    switch (kind) {
      case 'backup': {
        const spec = parseInstanceSpec(body['instance']);
        return enqueueBackup(spec);
      }
      case 'backup-control':
        return enqueueControl();
      case 'verify': {
        const objectKey = parseObjectKey(body['objectKey']);
        return queue.submit('verify', (signal) => runVerify(buildCtx(signal), objectKey));
      }
      case 'restore': {
        const objectKey = parseObjectKey(body['objectKey']);
        const ageIdentity = parseAgeIdentity(body['ageIdentity']);
        const target = parseInstanceSpec(body['target'], 'target');
        // Pflicht: SHA-256 der Sicherung laut Verwaltung (Echtheit unabhaengig vom Speicher des Ziels).
        const expectedSha256 = parseSha256(body['sha256']);
        // Optional: SHA-256 des Uploads-Archivs laut Verwaltung; fehlt bei Altbestand und Sicherungen ohne Uploads.
        const expectedUploadsSha256 = body['uploadsSha256'] === undefined ? undefined : parseSha256(body['uploadsSha256']);
        deps.redactor.add(ageIdentity);
        return queue.submit('restore', async (signal) => {
          try {
            return await runRestore(buildCtx(signal), { objectKey, ageIdentity, target, expectedSha256, expectedUploadsSha256 });
          } finally {
            deps.redactor.remove(ageIdentity);
          }
        });
      }
      default:
        throw new ValidationError('Feld kind ist ungueltig');
    }
  }

  async function route(method: string, url: URL, body: Buffer): Promise<{ status: number; json: unknown }> {
    const p = url.pathname;
    const parseJson = (): unknown => {
      try {
        return JSON.parse(body.toString('utf8') || '{}');
      } catch {
        throw new ValidationError('Body ist kein gueltiges JSON');
      }
    };

    if (method === 'GET' && p === '/v1/health') {
      return { status: 200, json: { status: 'ok', version: deps.version, targetConfigured: targets.isConfigured() } };
    }
    if (method === 'GET' && p === '/v1/target') return { status: 200, json: targets.metadata() };
    if (method === 'PUT' && p === '/v1/target') return { status: 200, json: await targets.put(parseJson()) };
    if (method === 'POST' && p === '/v1/target/test') return { status: 200, json: await targets.test() };
    if (method === 'POST' && p === '/v1/jobs') return { status: 202, json: { jobId: submitJob(parseJson()) } };
    if (method === 'GET' && p.startsWith('/v1/jobs/')) {
      const job = queue.get(p.slice('/v1/jobs/'.length));
      if (!job) throw new HttpError(404, 'Job nicht gefunden');
      return { status: 200, json: job };
    }
    if (method === 'GET' && p === '/v1/backups') {
      const kind = url.searchParams.get('kind') ?? undefined;
      if (kind && !['instance', 'control', 'invoices'].includes(kind)) throw new ValidationError('Parameter kind ist ungueltig');
      const sub = url.searchParams.get('subdomain') ?? undefined;
      if (sub) parseSubdomain(sub);
      return { status: 200, json: await listBackups(kind, sub) };
    }
    throw new HttpError(404, 'Nicht gefunden');
  }

  const server = http.createServer((req, res) => {
    const send = (status: number, json: unknown) => {
      const payload = Buffer.from(JSON.stringify(json));
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': payload.length });
      res.end(payload);
    };
    void (async () => {
      const method = req.method ?? 'GET';
      const rawUrl = req.url ?? '/';
      let status = 500;
      try {
        const declared = Number(req.headers['content-length'] ?? 0);
        if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'Body zu gross');
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const c of req) {
          total += (c as Buffer).length;
          if (total > MAX_BODY_BYTES) throw new HttpError(413, 'Body zu gross');
          chunks.push(c as Buffer);
        }
        const body = Buffer.concat(chunks);
        const v = verifyRequest({ secret: deps.secret, method, url: rawUrl, headers: req.headers, body, nonces });
        if (!v.ok) {
          status = v.status;
          deps.log.warn('Anfrage abgelehnt', { method, path: rawUrl.split('?')[0], reason: v.reason });
          return send(status, { error: 'unauthorized' });
        }
        const r = await route(method, new URL(rawUrl, 'http://agent'), body);
        status = r.status;
        send(status, r.json);
      } catch (e) {
        if (e instanceof HttpError) status = e.status;
        else if (e instanceof ValidationError) status = 400;
        else status = 500;
        const message = e instanceof HttpError || e instanceof ValidationError ? e.message : 'Interner Fehler';
        if (status === 500) deps.log.error('Unerwarteter Fehler', { error: safeMessage(deps.redactor, e) });
        if (!res.headersSent) send(status, { error: message });
      } finally {
        deps.log.info('request', { method, path: rawUrl.split('?')[0], status });
      }
    })();
  });
  server.requestTimeout = 120_000;

  return { server, queue, targets, scheduler };
}
