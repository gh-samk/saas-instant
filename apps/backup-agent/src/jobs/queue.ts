import { randomUUID } from 'node:crypto';
import { type Logger, type Redactor, safeMessage } from '../log.js';
import { DeferredError } from '../errors.js';
import type { JobKind, JobRecord, JobResult } from '../types.js';

const MAX_KEEP = 200;
/** Vorgabe fuer das Zeitlimit je Auftrag: grosszuegig (grosse Datenbanken, langsame Ziele), aber nicht endlos. */
export const DEFAULT_JOB_TIMEOUT_MS = 2 * 3_600_000;

/** Frist nach dem Abbruch, in der der abgebrochene Lauf enden muss, bevor ein neuer starten darf. */
export const DEFAULT_ABORT_GRACE_MS = 5 * 60_000;

export class JobTimeoutError extends Error {
  constructor(ms: number) {
    super(`Zeitlimit von ${Math.round(ms / 60_000)} Minuten ueberschritten, Auftrag abgebrochen`);
  }
}

/** Ein Job gleichzeitig (es gibt genau ein Ziel). Der Auftrag selbst wird nach dem Lauf vergessen. */
export class JobQueue {
  private readonly jobs = new Map<string, JobRecord>();
  private pending: { id: string; run: (signal: AbortSignal) => Promise<JobResult> }[] = [];
  private running = false;
  /** Ein abgebrochener Lauf endet nicht: bis er endet, startet kein neuer Auftrag (sonst liefen zwei gleichzeitig). */
  private blocked = false;
  private idle: (() => void)[] = [];

  constructor(
    private readonly redactor: Redactor,
    private readonly now: () => Date = () => new Date(),
    private readonly opts: { timeoutMs?: number; graceMs?: number; log?: Logger } = {},
  ) {}

  submit(kind: JobKind, run: (signal: AbortSignal) => Promise<JobResult | void>): string {
    const id = randomUUID();
    this.jobs.set(id, { id, kind, status: 'queued', startedAt: this.now().toISOString() });
    this.pending.push({ id, run: async (signal) => (await run(signal)) ?? {} });
    while (this.jobs.size > MAX_KEEP) {
      const oldest = [...this.jobs.values()].find((j) => j.status !== 'queued' && j.status !== 'running');
      if (!oldest) break;
      this.jobs.delete(oldest.id);
    }
    void this.pump();
    return id;
  }

  /** Jeder gescheiterte oder verschobene Lauf hinterlaesst eine Logzeile; sonst bliebe ein naechtlicher Fehler unbemerkt. */
  private logResult(rec: JobRecord): void {
    const log = this.opts.log;
    if (!log) return;
    const fields = { jobId: rec.id, kind: rec.kind, status: rec.status, ...(rec.message ? { message: rec.message } : {}) };
    if (rec.status === 'failed') log.error('Auftrag fehlgeschlagen', fields);
    else if (rec.status === 'deferred') log.warn('Auftrag verschoben', fields);
    else log.info('Auftrag abgeschlossen', fields);
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  hasActive(): boolean {
    return this.running || this.blocked || this.pending.length > 0;
  }

  isBlocked(): boolean {
    return this.blocked;
  }

  whenIdle(): Promise<void> {
    // Auch ein abgebrochener, noch laufender Zombie-Lauf zaehlt als nicht idle.
    return this.running || this.blocked ? new Promise((r) => this.idle.push(r)) : Promise.resolve();
  }

  /** Wartet nach `abort()` mit Frist auf das Ende des Laufs; bei Ueberschreitung wird die Warteschlange blockiert. */
  private async awaitEnd(work: Promise<JobResult>, rec: JobRecord): Promise<void> {
    const graceMs = this.opts.graceMs ?? DEFAULT_ABORT_GRACE_MS;
    let timer: NodeJS.Timeout | undefined;
    const ended = await Promise.race([
      work.then(() => true, () => true),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(false), graceMs);
        timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (ended) return;
    this.blocked = true;
    this.opts.log?.error('Abgebrochener Auftrag endet nicht; es starten keine neuen Auftraege, bis er beendet ist', {
      jobId: rec.id,
      kind: rec.kind,
      fristSekunden: Math.round(graceMs / 1000),
    });
    void work.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      this.blocked = false;
      this.opts.log?.warn('Abgebrochener Auftrag ist beendet; die Warteschlange laeuft weiter', { jobId: rec.id });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.blocked) {
        const next = this.pending.shift();
        if (!next) break;
        const rec = this.jobs.get(next.id)!;
        rec.status = 'running';
        rec.startedAt = this.now().toISOString();
        const timeoutMs = this.opts.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
        const ac = new AbortController();
        let timer: NodeJS.Timeout | undefined;
        let work: Promise<JobResult> | undefined;
        try {
          work = next.run(ac.signal);
          // Nach einem Abbruch laeuft `work` noch kurz weiter (Aufraeumen); sein Fehler ist dann erwartet.
          work.catch(() => undefined);
          const limit = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              ac.abort();
              reject(new JobTimeoutError(timeoutMs));
            }, timeoutMs);
            timer.unref();
          });
          rec.result = await Promise.race([work, limit]);
          rec.status = 'succeeded';
        } catch (e) {
          rec.status = e instanceof DeferredError ? 'deferred' : 'failed';
          rec.message = safeMessage(this.redactor, e);
          if (e instanceof JobTimeoutError && work) await this.awaitEnd(work, rec);
        } finally {
          if (timer) clearTimeout(timer);
        }
        rec.finishedAt = this.now().toISOString();
        this.logResult(rec);
      }
    } finally {
      this.running = false;
      if (!this.blocked) {
        const waiting = this.idle;
        this.idle = [];
        waiting.forEach((r) => r());
      }
    }
  }
}
