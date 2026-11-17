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
  /** Loescht `instances/<subdomain>/` im Ziel (Loeschung archivierter Instanzen nach 90 Tagen). */
  enqueuePurge?: (subdomain: string) => void;
  /** Rechnungsarchiv wurde verschoben (Verwaltung gesperrt) und wartet auf einen neuen Versuch. */
  invoicesDeferred?: () => boolean;
  enqueueInvoices?: () => void;
  log: Logger;
  redactor: Redactor;
}

/** Ein verpasster Slot wird nur nachgeholt, solange er hoechstens so lange zurueckliegt. */
const CATCH_UP_MS = 6 * 3_600_000;

/** Eigener Minutentakt-Planer (Serverzeit). `tick` ist von aussen aufrufbar, damit Tests ohne Timer laufen. */
export class Scheduler {
  /** Slots (Tag + Uhrzeit), die erledigt sind oder bewusst uebersprungen wurden. */
  private readonly done = new Set<string>();
  private baselined = false;
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

  /** Slots des Tages als Zeitpunkte. `new Date(y, m, d, h, min)` rueckt in der Luecke der Zeitumstellung (02:30 existiert nicht) auf 03:30 vor. */
  private slotsOf(schedule: TargetConfig['schedule'], now: Date): { id: string; at: Date }[] {
    return SLOTS[schedule].map((hhmm) => {
      const [h, m] = hhmm.split(':').map(Number) as [number, number];
      return {
        id: `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}T${hhmm}`,
        at: new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0),
      };
    });
  }

  async tick(now: Date): Promise<boolean> {
    const schedule = this.deps.schedule();
    if (!schedule) return false;
    this.retryDeferred(now);
    const slots = this.slotsOf(schedule, now);
    // Beim ersten Tick gelten Slots, die schon laenger vorbei sind (Neustart des Agenten), als erledigt:
    // sonst liefe nach jedem Neustart sofort eine Sicherung.
    if (!this.baselined) {
      this.baselined = true;
      for (const s of slots) if (now.getTime() - s.at.getTime() > 2 * 60_000) this.done.add(s.id);
    }
    // Faellig ist ein Slot, dessen Zeitpunkt erreicht ist. So wird auch ein verpasster Slot
    // nachgeholt: am letzten Maerzsonntag springt die Uhr von 02:00 auf 03:00, und 02:30 kommt nie.
    const due = slots.find((s) => !this.done.has(s.id) && now >= s.at && now.getTime() - s.at.getTime() < CATCH_UP_MS);
    if (!due) return false;
    for (const s of slots) if (s.at <= now) this.done.add(s.id); // zwei Slots verpasst: trotzdem nur ein Lauf
    if (this.done.size > 50) this.done.clear(); // nur der heutige Tag ist relevant
    await this.runAll();
    return true;
  }

  /** Hoechstens alle 10 Minuten: verschobenes Rechnungsarchiv erneut versuchen (nach dem Entsperren der Verwaltung) und nicht zugestellte Meldungen nachreichen. */
  private retryDeferred(now: Date): void {
    if (now.getTime() - this.lastRetry < 10 * 60_000) return;
    const invoices = !!this.deps.invoicesDeferred?.() && !!this.deps.enqueueInvoices;
    if (!invoices && !this.deps.control.flush) return;
    this.lastRetry = now.getTime();
    void this.deps.control.flush?.();
    if (invoices) this.deps.enqueueInvoices!();
  }

  async runAll(): Promise<void> {
    try {
      const plan = await this.deps.control.getPlan();
      for (const spec of plan.instances) this.deps.enqueueInstance(spec);
      for (const subdomain of plan.purge ?? []) this.deps.enqueuePurge?.(subdomain);
    } catch (e) {
      this.deps.log.error('Sicherungsplan konnte nicht geholt werden und es gibt keinen gemerkten Plan; Instanzen werden diesmal NICHT gesichert', {
        error: safeMessage(this.deps.redactor, e),
      });
    }
    this.deps.enqueueControl();
  }
}

export type { JobKind };
