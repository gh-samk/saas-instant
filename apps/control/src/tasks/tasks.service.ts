import { Injectable } from '@nestjs/common';
import { datePlusDays, dateStringFromDate, today } from '@saas-instant/shared';
import type { OrphanedApplication } from '../instances/instance.types';
import { OutboxService } from '../outbox/outbox.service';
import { PricingConfigService } from '../invoices/pricing.config';
import { PrismaService } from '../prisma/prisma.service';
import type {
  Task,
  TasksKind,
  TaskSource,
  Urgency,
} from './tasks.types';
import { reconciliationDeviation } from './sources/reconciliation-deviation.source';
import { inquiryUnanswered } from './sources/inquiry-unanswered.source';
import { auditRetention } from './sources/audit-retention.source';
import { backupMissing } from './sources/backup-missing.source';
import { noEntryForLong } from './sources/no-entry-for-long.source';
import { metricsQueryFailed } from './sources/metrics-failed.source';
import { deletionSuggestion } from './sources/deletion-suggestion.source';
import { companyNameMismatch } from './sources/company-name-mismatch.source';
import { outboxDisrupted } from './sources/outbox-disrupted.source';
import { priceInfoMissing } from './sources/price-missing.source';
import { invoiceDue } from './sources/invoice-due.source';
import { invoiceOverdue } from './sources/invoice-overdue.source';
import { statusChangeAutomatic } from './sources/status-change-automatic.source';
import { tierCheck } from './sources/tier-check.source';
import { instanceStillActive } from './sources/instance-still-active.source';
import { documentTampered } from './sources/document-tampered.source';
import { controlBackupMissing } from './sources/control-backup-missing.source';
import { purgeFailed } from './sources/purge-failed.source';

/**
 * Alle Quellen. Eine neue Aufgabenart wird HIER eingetragen — und sonst
 * nirgends.
 */
export const Sources: readonly TaskSource[] = [
  inquiryUnanswered,
  instanceStillActive,
  statusChangeAutomatic,
  deletionSuggestion,
  priceInfoMissing,
  auditRetention,
  // --- Etappe 3: Instanzen. Fünf neue Arten, keine Strukturänderung. ---
  backupMissing,
  metricsQueryFailed,
  reconciliationDeviation,
  noEntryForLong,
  companyNameMismatch,
  // --- Etappe 4: Rechnungen ---
  //
  // Die Vorbedingung dieses Eintrags ist erfuellt: `src/lib/aufgaben.ts` fuehrt
  // seit der Oberflaeche zu Etappe 4 die Funktionen `aufgabenIcon` und
  // `aufgabenBezeichnung` mit Rueckfallwert, und `DashboardSeite.tsx` benutzt
  // sie statt der direkten Record-Indizierung. Eine unbekannte Aufgabenart
  // ergibt dort jetzt ein neutrales Fragezeichen statt `undefined` als
  // Komponente — die Startseite kann daran nicht mehr abbrechen.
  //
  // Die Reihenfolge war wesentlich: erst der Rueckfallwert, dann die drei
  // Eintraege (`TasksKind`, `ActionKind`, Icon + Bezeichnung), dann diese
  // Zeile. Umgekehrt haette der erste ueberfaellige Beleg das Dashboard
  // ausgeschaltet.
  invoiceOverdue,
  // Die beiden Arten, die der Auftrag zu Etappe 4 nennt und die dort noch
  // fehlten. Dieselbe Reihenfolge wie damals: erst der Rueckfallwert in
  // `src/lib/aufgaben.ts`, dann die Eintraege in `TasksKind`, Icon und
  // Bezeichnung, dann diese Zeilen. Umgekehrt haette die erste Aufgabe dieser
  // Art die Startseite ausgeschaltet.
  //
  // KEINE VON BEIDEN VOLLZIEHT ETWAS (R5): Die eine legt keine Rechnung an,
  // die andere aendert keine Preisvereinbarung. Beide fuehren nur hin.
  invoiceDue,
  tierCheck,
  outboxDisrupted,
  // GoBD-Integritaet (Pruefsumme / Nummernkreis), live gerechnet.
  documentTampered,
  // Sicherung der Verwaltung (Datenbank/Rechnungsarchiv) ueberfaellig.
  controlBackupMissing,
  // Archivierte Instanz über die Löschfrist hinaus noch da.
  purgeFailed,
];

/** Voreinstellung für „seit dem letzten Blick", wenn niemand etwas sagt. */
export const LOOKBACK_DAYS = 7;

/**
 * Wie weit `since` höchstens zurückreichen darf ([W7]).
 *
 * Ohne Grenze ließe sich mit `?seit=2000-01-01` das ganze Audit-Log als
 * Aufgabenliste abrufen. Die Rückschau soll den Tag ordnen, nicht die
 * Geschichte erzählen.
 */
export const LOOKBACK_MAX_DAYS = 90;

/**
 * Höchstzahl Aufgaben JE ART ([W7]).
 *
 * Gemessen wurden 5010 Aufgaben und 2,03 MB in einer Antwort. Eine Liste, die
 * niemand liest, ist keine Aufgabenliste. Was darüber hinausgeht, wird gezählt
 * und als „… und N weitere" gemeldet.
 */
export const LIMIT_PER_KIND = 25;

const Order: Record<Urgency, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    // Die Preistafel gehoert in den Kontext und nicht in die Quelle: Sie kommt
    // aus der Umgebung (`CONTROL_PRICE_TABLE`), und eine Quelle ist ein
    // einfaches Objekt ohne NestJS-Einbindung.
    private readonly priceConfig: PricingConfigService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Leitet alle Aufgaben aus dem Datenbestand ab. Nichts davon wird
   * gespeichert.
   *
   * Ein Fehler in einer Quelle wird ABSICHTLICH nicht gefangen: eine
   * Aufgabenliste, der stillschweigend eine Art fehlt, ist schlimmer als eine,
   * die sichtbar nicht lädt. Sonst hieße „keine Aufgaben" irgendwann „die
   * Abfrage ist kaputt", und niemand merkte es.
   */
  async collect(since?: string): Promise<TasksResponse> {
    const todayDay = today();
    const sinceDay = limitLookback(
      since ?? datePlusDays(todayDay, -LOOKBACK_DAYS),
      todayDay,
    );
    const context = {
      prisma: this.prisma,
      todayDay,
      now: new Date(),
      since: sinceDay,
      limit: LIMIT_PER_KIND,
      priceTable: this.priceConfig.read(),
      outbox: this.outbox.situation(),
    };

    const collected = await Promise.all(
      Sources.map(async (source) => ({
        kind: source.kind,
        ...(await source.collect(context)),
      })),
    );

    const tasks = collected.flatMap((e) => e.tasks).sort(compare);
    const shortened = collected
      .filter((e) => e.total > e.tasks.length)
      .map((e) => ({
        kind: e.kind,
        shown: e.tasks.length,
        further: e.total - e.tasks.length,
      }));

    return {
      tasks,
      shortened,
      // Coolify-Anwendungen OHNE CRM-Eintrag. Sie haben keine Organisation, an
      // die sich eine Aufgabe hängen liesse — deshalb eine eigene Liste in
      // derselben Antwort statt eines erfundenen Platzhalter-Ziels.
      orphanedApplications: await this.orphanedApplications(),
      state: {
        day: todayDay,
        since: sinceDay,
        limitPerKind: LIMIT_PER_KIND,
        reconciliation: await this.reconciliationState(),
      },
    };
  }

  /** Der Befund des letzten Abgleichs, soweit er erfolgreich war. */
  private async orphanedApplications(): Promise<OrphanedApplication[]> {
    const run = await this.prisma.reconciliationRun.findFirst({
      orderBy: { executedAt: 'desc' },
    });
    if (run === null || !run.successful) return [];
    // Die JSON-Spalte stammt aus einem früheren Lauf und wird defensiv
    // gelesen: was nicht die vereinbarte Form hat, fällt weg.
    const raw: unknown = run.orphanedApplications;
    if (!Array.isArray(raw)) return [];
    return (raw as unknown[]).filter(
      (e): e is OrphanedApplication =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as OrphanedApplication).subdomain === 'string',
    );
  }

  /**
   * Wann lief der Abgleich zuletzt, und lief er durch?
   *
   * EIN LEERER BEFUND UND EIN AUSGEFALLENER LAUF SIND NICHT DASSELBE. Ohne
   * diese Angabe läse die Oberfläche „keine Abweichungen", obwohl in
   * Wahrheit seit einer Woche nichts gemessen wurde — die beruhigendste aller
   * falschen Auskünfte.
   */
  private async reconciliationState(): Promise<{
    lastAt: string | null;
    successful: boolean;
    message: string | null;
  }> {
    const run = await this.prisma.reconciliationRun.findFirst({
      orderBy: { executedAt: 'desc' },
    });
    if (run === null) {
      return { lastAt: null, successful: false, message: 'Noch kein Abgleich gelaufen.' };
    }
    return {
      lastAt: dateStringFromDate(
        new Date(
          Date.UTC(
            run.executedAt.getUTCFullYear(),
            run.executedAt.getUTCMonth(),
            run.executedAt.getUTCDate(),
          ),
        ),
      ),
      successful: run.successful,
      message: run.message,
    };
  }
}

/** Was `GET /api/aufgaben` liefert. */
export interface TasksResponse {
  tasks: Task[];
  /** Was je Art weggelassen wurde, damit die Oberfläche es benennen kann. */
  shortened: { kind: TasksKind; shown: number; further: number }[];
  orphanedApplications: OrphanedApplication[];
  state: {
    day: string;
    since: string;
    limitPerKind: number;
    reconciliation: { lastAt: string | null; successful: boolean; message: string | null };
  };
}

/** Dringendes zuerst, bei gleicher Dringlichkeit das Ältere zuerst. */
export function compare(a: Task, b: Task): number {
  const afterUrgency =
    Order[a.urgency] - Order[b.urgency];
  if (afterUrgency !== 0) return afterUrgency;
  if (a.dueAt !== b.dueAt) return a.dueAt < b.dueAt ? -1 : 1;
  // Aufgaben ohne Organisationsbezug (Aufbewahrungsfrist) ganz nach hinten.
  return (a.company?.name ?? '\uffff').localeCompare(
    b.company?.name ?? '\uffff',
    'de',
  );
}

/**
 * Begrenzt die Rückschau auf `LOOKBACK_MAX_DAYS` ([W7]).
 *
 * Ein Datum in der Zukunft bleibt unangetastet — es liefert schlicht nichts,
 * und das ist eine ehrlichere Antwort als eine stillschweigende Korrektur.
 */
export function limitLookback(since: string, todayDay: string): string {
  const earliest = datePlusDays(todayDay, -LOOKBACK_MAX_DAYS);
  return since < earliest ? earliest : since;
}
