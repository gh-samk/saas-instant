import type { ControlClient } from './control-client.js';
import type { JobKind } from './types.js';
import type { Logger, Redactor } from './log.js';
import { safeMessage } from './log.js';
import type { TargetConfig, InstanceSpec } from './types.js';

export const SLOTS: Record<TargetConfig['schedule'], string[]> = {
  daily: ['02:30'],
  twice_daily: ['02:30', '14:30'],
};

export interface SchedulerDeps {
  control: ControlClient;
  schedule: () => TargetConfig['schedule'] | null;
  enqueueInstance: (spec: InstanceSpec) => void;
  enqueueControl: () => void;
  /** Rechnungsarchiv wurde verschoben (Verwaltung gesperrt) und wartet auf einen neuen Versuch. */
  invoicesDeferred?: () => boolean;
  enqueueInvoices?: () => void;
  log: Logger;
  redactor: Redactor;
}

/** Eigener Minutentakt-Planer (Serverzeit). `tick` ist von aussen aufrufbar, damit Tests ohne Timer laufen. */
export class Scheduler {
  private lastSlot = '';
  private lastRetry = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: SchedulerDeps) {}

  start(intervalMs = 30_000): void {
    this.timer = setInterval(() => void this.tick(new Date()), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now: Date): Promise<boolean> {
    const schedule = this.deps.schedule();
    if (!schedule) return false;
    this.retryDeferred(now);
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (!SLOTS[schedule].includes(hhmm)) return false;
    const slotId = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}T${hhmm}`;
    if (slotId === this.lastSlot) return false;
    this.lastSlot = slotId;
    await this.runAll();
    return true;
  }

  /** Hoechstens alle 10 Minuten: verschobenes Rechnungsarchiv erneut versuchen (nach dem Entsperren der Verwaltung). */
  private retryDeferred(now: Date): void {
    if (!this.deps.invoicesDeferred?.() || !this.deps.enqueueInvoices) return;
    if (now.getTime() - this.lastRetry < 10 * 60_000) return;
    this.lastRetry = now.getTime();
    this.deps.enqueueInvoices();
  }

  async runAll(): Promise<void> {
    try {
      for (const spec of (await this.deps.control.getPlan()).instances) this.deps.enqueueInstance(spec);
    } catch (e) {
      this.deps.log.error('Sicherungsplan konnte nicht geholt werden', { error: safeMessage(this.deps.redactor, e) });
    }
    this.deps.enqueueControl();
  }
}

export type { JobKind };
