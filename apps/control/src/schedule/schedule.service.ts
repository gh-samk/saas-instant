import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { CompanyStatus } from '.prisma/control-client';
import { datePlusDays, dateStringFromDate, today, toDate } from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import type { InquirySource } from '../common/inquiry-source';
import { datePlusMonths } from '../common/calendar';
import {
  PILOT_TO_PAYING_AFTER_DAYS,
  REVIEW_AFTER_MONTHS,
  reviewDateFrom,
} from '../companies/deadlines';
import { performStatusChange } from '../companies/status-change';
import { PrismaService } from '../prisma/prisma.service';

/** Ein fälliger Wechsel, bevor er vollzogen ist. */
interface Due {
  companyId: string;
  name: string;
  fromStatus: CompanyStatus;
  afterStatus: CompanyStatus;
  reason: string;
}

export interface ScheduleResult {
  day: string;
  checked: number;
  changed: number;
  /** Schon vollzogen — der Normalfall beim zweiten Lauf desselben Tages. */
  skipped: number;
  error: number;
}

/**
 * DER ERSTE AUTOMATISCHE SCHREIBVORGANG IM CRM.
 *
 * Zwei Wechsel, beide OHNE GELDFOLGE — und das ist die Bedingung, unter der R5
 * sie überhaupt erlaubt:
 *
 * - `pilot_running` → `paying`, 90 Tage nach `instanceStartDate`. Der Status
 *   sagt, dass die Pilotphase vorbei ist. Er stellt nichts in Rechnung: eine
 *   Rechnung entsteht in Etappe 4 ausschließlich durch eine Handlung.
 * - → `review_pending`, ab `pilotDecisionDate` plus sieben Monate. Das
 *   ist eine Erinnerung, kein Beschluss.
 *
 * Alles mit Geldfolge wird VORGESCHLAGEN, nicht vollzogen — dafür ist das
 * Modul `tasks` da (R5).
 *
 * DREI EIGENSCHAFTEN, die der Auftrag verlangt und die einzeln geprüft werden:
 * 1. IDEMPOTENT. Der Lauf darf mehrmals am Tag stattfinden. Der Schreibvorgang
 *    ist bedingt (`status = vonStatus`), ein zweiter Lauf trifft nichts mehr.
 * 2. KEIN ABBRUCH. Ein Fehler bei einer Organisation wird gezählt und
 *    protokolliert; die übrigen laufen weiter.
 * 3. NACHVOLLZIEHBAR. Jeder Wechsel hinterlässt eine systemerzeugte Notiz und
 *    einen Audit-Eintrag mit Vorher/Nachher.
 */
@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);
  /**
   * Läuft gerade ein Durchgang?
   *
   * Schützt gegen ÜBERLAPPUNG im selben Prozess (langer Lauf, nächster Auslöser
   * kommt schon). Gegen zwei PROZESSE schützt er nicht — dagegen schützt das
   * bedingte Schreiben, und das ist die eigentliche Absicherung.
   */
  private runs = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  /** Täglich um 3 Uhr — außerhalb der Arbeitszeit der Betreiberin. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'schedule-daily' })
  async dailyRun(): Promise<void> {
    if (this.config.get<string>('CONTROL_SCHEDULE_ENABLED', 'ja') === 'nein') {
      this.logger.log('Zeitplan ist abgeschaltet (CONTROL_SCHEDULE_ENABLED=nein).');
      return;
    }
    if (this.runs) {
      this.logger.warn('Vorheriger Zeitplan-Lauf ist noch nicht fertig.');
      return;
    }
    this.runs = true;
    try {
      await this.runFrom({ actor: 'schedule', userId: null });
    } finally {
      this.runs = false;
    }
  }

  /**
   * Führt einen Durchgang aus.
   *
   * Öffentlich, damit sich der Lauf auch von Hand auslösen lässt (Endpunkt
   * `POST /api/zeitplan/lauf`) — sonst wäre er nur einmal am Tag prüfbar.
   */
  async runFrom(
    trigger: { actor: string; userId: string | null },
    source?: InquirySource,
  ): Promise<ScheduleResult> {
    const day = today();
    const due = await this.due(day);
    let changed = 0;
    let skipped = 0;
    let error = 0;

    for (const entry of due) {
      try {
        const result = await performStatusChange(this.prisma, this.audit, {
          companyId: entry.companyId,
          fromStatus: entry.fromStatus,
          afterStatus: entry.afterStatus,
          action: AUDIT_ACTION.companyStatusAutomatic,
          actor: trigger.actor,
          userId: trigger.userId,
          introduction: 'Status automatisch gewechselt',
          reason: entry.reason,
          source,
        });
        if (result === 'changed') changed += 1;
        else skipped += 1;
      } catch (exception) {
        // EIN Fehler darf die übrigen nicht mitreißen: sonst bliebe nach der
        // ersten kaputten Organisation der Rest des Bestands ungeprüft liegen,
        // und zwar jede Nacht wieder.
        error += 1;
        const reason =
          exception instanceof Error ? exception.message : String(exception);
        this.logger.error(
          `Statuswechsel für Organisation ${entry.companyId} ` +
            `(${entry.name}) fehlgeschlagen: ${reason}`,
        );
      }
    }

    const result: ScheduleResult = {
      day,
      checked: due.length,
      changed,
      skipped,
      error,
    };
    this.logger.log(
      `Zeitplan ${day}: ${due.length} fällig, ${changed} gewechselt, ` +
        `${skipped} bereits erledigt, ${error} Fehler.`,
    );
    // Der Abschlusseintrag ist eine ZUSAMMENFASSUNG, kein Nachweis: Jeder
    // einzelne Wechsel steht bereits mit Vorher/Nachher im Audit-Log, und zwar
    // in derselben Transaktion wie die Änderung selbst. Scheitert nur diese
    // Zusammenfassung, wäre es falsch, den ganzen Lauf als gescheitert zu
    // melden — die Arbeit ist getan und protokolliert ([H3]).
    try {
      await this.audit.log({
        userId: trigger.userId,
        actor: trigger.actor,
        action: AUDIT_ACTION.scheduleRun,
        objectType: 'Schedule',
        objectId: null,
        afterValue: result,
        ip: source?.ip ?? null,
        userAgent: source?.userAgent ?? null,
      });
    } catch (exception) {
      const reason =
        exception instanceof Error ? exception.message : String(exception);
      this.logger.error(
        `Zusammenfassung des Zeitplan-Laufs konnte nicht protokolliert ` +
          `werden: ${reason}. Die einzelnen Wechsel stehen im Audit-Log.`,
      );
    }
    return result;
  }

  /**
   * Sammelt die fälligen Wechsel — HÖCHSTENS EINER JE ORGANISATION UND LAUF.
   *
   * Die Überprüfung hat Vorrang vor „zahlend": Sie liegt zeitlich später
   * (sieben Monate gegen 90 Tage). Wer beides zugleich erfüllt, war lange
   * unbeobachtet; ihn erst nach `paying` und morgen nach `review_pending`
   * zu schieben, erzeugte einen Zwischenstand, den es nie gab, samt zweier
   * Notizen.
   */
  private async due(day: string): Promise<Due[]> {
    const decisionLimit = datePlusMonths(day, -REVIEW_AFTER_MONTHS);
    const startLimit = datePlusDays(day, -PILOT_TO_PAYING_AFTER_DAYS);

    // Die Quittung wird ZEILENWEISE verglichen und nicht in der Abfrage:
    // „erledigt nach dem eigenen Termin" setzt zwei Spalten derselben Zeile
    // gegeneinander, und das kann Prisma in `where` nicht ausdrücken. Die
    // Kandidatenmenge ist klein (nur Überfällige), deshalb ist das billig.
    const reviewCandidates = await this.prisma.company.findMany({
      where: {
        status: { in: ['pilot_running', 'paying'] },
        pilotDecisionDate: { not: null, lte: toDate(decisionLimit) },
      },
      select: {
        id: true,
        name: true,
        status: true,
        pilotDecisionDate: true,
        reviewDoneAt: true,
      },
    });
    const toReview = reviewCandidates.filter((row) =>
      isOpen(row.pilotDecisionDate, row.reviewDoneAt),
    );

    // OHNE PREISVEREINBARUNG KEIN WECHSEL AUF `paying` ([H1]).
    //
    // Der Wechsel ist heute folgenlos — das ist die Bedingung, unter der R5 ihn
    // erlaubt. Aber `paying` ist der Status, auf dem in Etappe 4 die
    // Rechnungen aufsetzen. Ohne Preisstufe und ohne abweichenden Betrag wäre
    // er eine Behauptung ohne Grundlage, und die Zusicherung „ohne Geldfolge"
    // verfiele still, sobald die Rechnungen dazukommen. Solche Organisationen
    // übergeht der Zeitplan; `tasks/quellen/preisangabe-fehlt` meldet sie
    // stattdessen — vorgeschlagen statt vollzogen, genau wie R5 es verlangt.
    const toPaying = await this.prisma.company.findMany({
      where: {
        status: 'pilot_running',
        instanceStartDate: { not: null, lte: toDate(startLimit) },
        OR: [
          { priceTier: { not: null } },
          { customAmount: { not: null } },
        ],
      },
      select: { id: true, name: true, status: true },
    });

    const due = new Map<string, Due>();
    for (const row of toReview) {
      due.set(row.id, {
        companyId: row.id,
        name: row.name,
        fromStatus: row.status,
        afterStatus: 'review_pending',
        reason: `${REVIEW_AFTER_MONTHS} Monate nach dem Pilotbeschluss`,
      });
    }
    for (const row of toPaying) {
      if (due.has(row.id)) continue;
      due.set(row.id, {
        companyId: row.id,
        name: row.name,
        fromStatus: row.status,
        afterStatus: 'paying',
        reason: `${PILOT_TO_PAYING_AFTER_DAYS} Tage nach dem Instanzstart`,
      });
    }
    return [...due.values()];
  }
}

/**
 * Steht die Überprüfung noch offen? ([K2])
 *
 * Offen ist sie, solange es keine Quittung gibt — oder die vorhandene VOR dem
 * jetzt fälligen Termin liegt. Der zweite Fall ist der, der nach einer
 * Berichtigung des Beschlussdatums greift: Der Termin wandert nach hinten, und
 * eine Quittung von davor gehört zu einer anderen Überprüfung.
 *
 * Verglichen werden Tagesdaten als Zeichenketten `YYYY-MM-DD` — die Ordnung
 * ist dort dieselbe wie auf dem Kalender.
 */
export function isOpen(
  pilotDecisionDate: Date | null,
  reviewDoneAt: Date | null,
): boolean {
  if (pilotDecisionDate === null) return false;
  if (reviewDoneAt === null) return true;
  const date = reviewDateFrom(
    dateStringFromDate(pilotDecisionDate),
  );
  if (date === null) return true;
  return dateStringFromDate(reviewDoneAt) < date;
}
