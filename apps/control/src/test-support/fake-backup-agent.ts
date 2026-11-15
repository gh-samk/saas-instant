import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sign } from '../backup-settings/agent-signature';

/**
 * ATTRAPPE DES SICHERUNGS-AGENTS (nur Prüfläufe, node:http).
 *
 * Sie hält die Regeln des echten Agents ein, soweit die Verwaltung sie
 * berührt: HMAC prüfen (zeitkonstant), Zeitfenster 60 s, Nonce nur einmal,
 * Body höchstens 1 MiB. Alles Weitere ist frei einstellbar.
 */
export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export class FakeBackupAgent {
  readonly requests: RecordedRequest[] = [];
  /** Anfragen, die die Signaturprüfung nicht bestanden haben. */
  rejected = 0;
  /** Zustand je Auftrag; der Test kann ihn vorgeben. */
  readonly jobs = new Map<string, Record<string, unknown>>();
  /** Antwort auf PUT /v1/target (frei einstellbar, z. B. mit ageIdentity). */
  putTargetReply: Record<string, unknown> = { ok: true, ageRecipient: 'age1testempfaenger' };
  /** Antwort auf GET /v1/target (frei einstellbar). */
  targetReply: Record<string, unknown> = {
    type: 's3',
    bucket: 'b',
    objectLock: false,
    ageRecipient: 'age1testempfaenger',
  };
  testReply: Record<string, unknown> = { ok: true, message: 'Verbindung in Ordnung' };
  /** Wenn gesetzt, antwortet der Agent auf jede Anfrage mit diesem Status. */
  failWith: number | null = null;
  /** Wie viele Abfragen ein Auftrag „running" bleibt, bevor er das Ziel erreicht. */
  runningPolls = 1;
  /** Endzustand neu angelegter Aufträge. */
  finalStatus: 'succeeded' | 'failed' = 'succeeded';
  finalMessage: string | undefined;

  private server: Server | null = null;
  private readonly seen = new Set<string>();
  private counter = 0;
  private readonly polls = new Map<string, number>();

  constructor(private readonly secret: string) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((done) => this.server?.listen(0, '127.0.0.1', done));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((done) => server.close(() => done()));
  }

  jobBodies(kind: string): Record<string, unknown>[] {
    return this.requests
      .filter((r) => r.method === 'POST' && r.path === '/v1/jobs')
      .map((r) => JSON.parse(r.body) as Record<string, unknown>)
      .filter((b) => b['kind'] === kind);
  }

  private async handle(
    req: IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = String(v);
    const method = req.method ?? 'GET';
    const path = req.url ?? '/';
    this.requests.push({ method, path, headers, body: raw.toString('utf8') });

    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    const timestamp = headers['x-si-timestamp'] ?? '';
    const nonce = headers['x-si-nonce'] ?? '';
    const expected = sign(this.secret, { method, pathWithQuery: path, timestamp, nonce, body: raw });
    const fresh = Math.abs(Date.now() - Number(timestamp)) <= 60_000;
    if (
      !fresh ||
      nonce.length < 32 ||
      this.seen.has(nonce) ||
      headers['x-si-signature'] !== expected ||
      raw.length > 1024 * 1024
    ) {
      this.rejected += 1;
      reply(401, { error: 'Signatur ungültig' });
      return;
    }
    this.seen.add(nonce);

    if (this.failWith !== null) {
      reply(this.failWith, { message: 'Attrappe: absichtlicher Fehler' });
      return;
    }

    const route = `${method} ${path.split('?')[0]}`;
    if (route === 'GET /v1/health') {
      reply(200, { status: 'ok', version: '0.0.0-test', targetConfigured: true });
    } else if (route === 'GET /v1/target') {
      reply(200, this.targetReply);
    } else if (route === 'PUT /v1/target') {
      reply(200, this.putTargetReply);
    } else if (route === 'POST /v1/target/test') {
      reply(200, this.testReply);
    } else if (route === 'POST /v1/jobs') {
      this.counter += 1;
      const id = `job-${String(this.counter).padStart(8, '0')}`;
      const body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      this.jobs.set(id, { id, kind: body['kind'], status: 'queued', startedAt: new Date().toISOString() });
      reply(202, { jobId: id });
    } else if (method === 'GET' && path.startsWith('/v1/jobs/')) {
      const id = decodeURIComponent(path.slice('/v1/jobs/'.length));
      const job = this.jobs.get(id);
      if (job === undefined) {
        reply(404, { message: 'unbekannt' });
        return;
      }
      const count = (this.polls.get(id) ?? 0) + 1;
      this.polls.set(id, count);
      if (count <= this.runningPolls) {
        job['status'] = 'running';
      } else if (job['status'] !== 'succeeded' && job['status'] !== 'failed') {
        job['status'] = this.finalStatus;
        job['finishedAt'] = new Date().toISOString();
        if (this.finalMessage !== undefined) job['message'] = this.finalMessage;
      }
      reply(200, job);
    } else if (route === 'GET /v1/backups') {
      reply(200, []);
    } else {
      reply(404, { message: 'unbekannt' });
    }
  }
}
