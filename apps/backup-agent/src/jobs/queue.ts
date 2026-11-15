import { randomUUID } from 'node:crypto';
import { type Redactor, safeMessage } from '../log.js';
import type { JobKind, JobRecord, JobResult } from '../types.js';

const MAX_KEEP = 200;

/** Ein Job gleichzeitig (es gibt genau ein Ziel). Der Auftrag selbst wird nach dem Lauf vergessen. */
export class JobQueue {
  private readonly jobs = new Map<string, JobRecord>();
  private pending: { id: string; run: () => Promise<JobResult> }[] = [];
  private running = false;
  private idle: (() => void)[] = [];

  constructor(
    private readonly redactor: Redactor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  submit(kind: JobKind, run: () => Promise<JobResult | void>): string {
    const id = randomUUID();
    this.jobs.set(id, { id, kind, status: 'queued', startedAt: this.now().toISOString() });
    this.pending.push({ id, run: async () => (await run()) ?? {} });
    while (this.jobs.size > MAX_KEEP) {
      const oldest = [...this.jobs.values()].find((j) => j.status === 'succeeded' || j.status === 'failed');
      if (!oldest) break;
      this.jobs.delete(oldest.id);
    }
    void this.pump();
    return id;
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  hasActive(): boolean {
    return this.running || this.pending.length > 0;
  }

  whenIdle(): Promise<void> {
    return this.hasActive() ? new Promise((r) => this.idle.push(r)) : Promise.resolve();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let next = this.pending.shift(); next; next = this.pending.shift()) {
        const rec = this.jobs.get(next.id)!;
        rec.status = 'running';
        rec.startedAt = this.now().toISOString();
        try {
          rec.result = await next.run();
          rec.status = 'succeeded';
        } catch (e) {
          rec.status = 'failed';
          rec.message = safeMessage(this.redactor, e);
        }
        rec.finishedAt = this.now().toISOString();
      }
    } finally {
      this.running = false;
      const waiting = this.idle;
      this.idle = [];
      waiting.forEach((r) => r());
    }
  }
}
