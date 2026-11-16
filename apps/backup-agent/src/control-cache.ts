import type { BackupPlan, BackupReport, ControlClient, InvoiceArchivePage } from './control-client.js';
import { ControlHttpError } from './errors.js';
import { type Logger, type Redactor, safeMessage } from './log.js';
import type { StateStore } from './state.js';
import { isRecord, parseInstanceSpec } from './validate.js';

const PLAN_FILE = 'plan';
const PENDING_FILE = 'pending-reports';
/** Hoechstens so viele Meldungen werden vorgehalten (aelteste fallen zuerst heraus, mit Logzeile). */
export const MAX_PENDING_REPORTS = 500;

interface CachedPlan {
  fetchedAt: string;
  plan: BackupPlan;
}

/** Nur Fehler, die von selbst weggehen koennen (gesperrt, Netz, 5xx, 408, 429), lohnen ein spaeteres Nachreichen. */
function retriable(e: unknown): boolean {
  if (e instanceof ControlHttpError) return e.status >= 500 || e.status === 408 || e.status === 429;
  return true; // 423 (gesperrt) und Netzfehler
}

/**
 * Macht den Agenten unabhaengig davon, ob die Verwaltung gerade antwortet.
 *
 * WARUM: Nach einem Neustart ist die Verwaltung gesperrt, bis jemand den Tresor
 * entsperrt, und auch ein Netzfehler oder ein Neustart der Verwaltung darf die
 * naechtliche Sicherung nicht ausfallen lassen. Der Agent merkt sich deshalb den
 * zuletzt gueltigen Plan (verschluesselt im State-Volume) und arbeitet bei einem
 * Fehler damit weiter. Meldungen, die nicht ankommen, werden vorgehalten und
 * spaeter nachgereicht, damit die Aufgabe "Sicherung ueberfaellig" nicht zu
 * Unrecht anschlaegt und nichts still verloren geht.
 */
export class ResilientControlClient implements ControlClient {
  private flushing = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly inner: ControlClient,
    private readonly store: StateStore,
    private readonly log: Logger,
    private readonly redactor: Redactor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getPlan(): Promise<BackupPlan> {
    try {
      const plan = await this.inner.getPlan();
      await this.store
        .saveAux(PLAN_FILE, { fetchedAt: this.now().toISOString(), plan } satisfies CachedPlan)
        .catch((e: unknown) => this.log.warn('Sicherungsplan konnte nicht zwischengespeichert werden', { error: safeMessage(this.redactor, e) }));
      void this.flush();
      return plan;
    } catch (e) {
      const cached = await this.loadPlan();
      if (!cached) throw e;
      this.log.warn(
        'Sicherungsplan nicht abrufbar; es gilt der zuletzt gueltige Plan (Instanzen, die seitdem neu hinzukamen, fehlen bis zur naechsten erfolgreichen Abfrage)',
        { error: safeMessage(this.redactor, e), planVom: cached.fetchedAt, instanzen: cached.plan.instances.length },
      );
      return cached.plan;
    }
  }

  getInvoiceArchivePage(after?: string): Promise<InvoiceArchivePage> {
    return this.inner.getInvoiceArchivePage(after);
  }

  async report(entry: BackupReport): Promise<void> {
    try {
      await this.inner.report(entry);
      await this.flush();
    } catch (e) {
      if (!retriable(e)) throw e;
      await this.enqueue(entry);
      this.log.warn('Meldung an die Verwaltung nicht zugestellt; sie wird zwischengespeichert und spaeter nachgereicht', {
        error: safeMessage(this.redactor, e),
        kind: entry.kind,
        date: entry.date,
      });
    }
  }

  /**
   * Alle Zugriffe auf die Vorhaltedatei laufen nacheinander (eine Promise-Kette); sonst ueberschriebe
   * ein laufendes flush eine Meldung, die waehrenddessen eingereiht wurde.
   */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Reicht vorgehaltene Meldungen der Reihe nach nach; stoppt beim ersten Fehler, der von selbst weggehen kann. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const snapshot = await this.locked(() => this.loadPending());
      if (snapshot.length === 0) return;
      const handled: BackupReport[] = []; // zugestellt oder endgueltig abgelehnt
      let stopped = false;
      // Das Netz laeuft ausserhalb der Sperre: report() reiht waehrenddessen weiter ein.
      for (const entry of snapshot) {
        try {
          await this.inner.report(entry);
          handled.push(entry);
        } catch (e) {
          if (retriable(e)) {
            stopped = true;
            break;
          }
          handled.push(entry);
          this.log.warn('Zwischengespeicherte Meldung wurde von der Verwaltung abgelehnt und verworfen', {
            error: safeMessage(this.redactor, e),
            kind: entry.kind,
            date: entry.date,
          });
        }
      }
      // Zusammenfuehren: nur die erledigten Eintraege entfernen, in der Zwischenzeit Eingereihtes bleibt.
      const done = new Set(handled.map((x) => JSON.stringify(x)));
      await this.locked(async () => {
        const current = await this.loadPending();
        await this.store.saveAux(PENDING_FILE, current.filter((x) => !done.has(JSON.stringify(x)))).catch((e: unknown) => {
          this.log.warn('Vorhaltedatei konnte nicht aktualisiert werden', { error: safeMessage(this.redactor, e) });
        });
      });
      if (!stopped) this.log.info('Zwischengespeicherte Meldungen an die Verwaltung nachgereicht');
    } catch (e) {
      this.log.warn('Zwischengespeicherte Meldungen konnten nicht nachgereicht werden', { error: safeMessage(this.redactor, e) });
    } finally {
      this.flushing = false;
    }
  }

  private enqueue(entry: BackupReport): Promise<void> {
    return this.locked(async () => {
      const list = await this.loadPending();
      // Eine neuere Meldung zum selben Objekt ersetzt die aeltere.
      const kept = list.filter((x) => !(x.kind === entry.kind && x.objectKey === entry.objectKey && x.date === entry.date && x.subdomain === entry.subdomain));
      kept.push(entry);
      while (kept.length > MAX_PENDING_REPORTS) {
        kept.shift();
        this.log.warn('Zu viele nicht zugestellte Meldungen; die aelteste wird verworfen');
      }
      await this.store.saveAux(PENDING_FILE, kept).catch((e: unknown) => {
        this.log.error('Nicht zugestellte Meldung konnte nicht gespeichert werden', { error: safeMessage(this.redactor, e) });
      });
    });
  }

  private async loadPending(): Promise<BackupReport[]> {
    try {
      const v = await this.store.loadAux<unknown>(PENDING_FILE);
      if (!Array.isArray(v)) return [];
      return v.filter(
        (x): x is BackupReport =>
          isRecord(x) && typeof x['kind'] === 'string' && typeof x['date'] === 'string' && typeof x['sizeBytes'] === 'number',
      );
    } catch {
      return [];
    }
  }

  private async loadPlan(): Promise<CachedPlan | null> {
    try {
      const v = await this.store.loadAux<unknown>(PLAN_FILE);
      if (!isRecord(v) || typeof v['fetchedAt'] !== 'string' || !isRecord(v['plan']) || !Array.isArray(v['plan']['instances'])) return null;
      const instances = [];
      for (const item of v['plan']['instances'] as unknown[]) {
        try {
          instances.push(parseInstanceSpec(item));
        } catch {
          /* beschaedigter Eintrag: ueberspringen */
        }
      }
      const years = v['plan']['retentionYears'];
      return {
        fetchedAt: v['fetchedAt'],
        plan: { ...(typeof years === 'number' ? { retentionYears: years } : {}), instances },
      };
    } catch {
      return null;
    }
  }
}
