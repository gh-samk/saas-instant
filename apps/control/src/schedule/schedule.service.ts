import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { CompanyStatus } from '.prisma/control-client';
import { datePlusDays, today, toDate } from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import type { InquirySource } from '../common/inquiry-source';
import { TRIAL_DAYS } from '../companies/deadlines';
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
 * Ein Wechsel, OHNE GELDFOLGE — und das ist die Bedingung, unter der R5 ihn
 * überhaupt erlaubt:
 *
 * - `trial` → `paying`, 14 Tage nach `instanceStartDate`. Der Status sagt,
 *   dass die Testphase vorbei ist. Er stellt nichts in Rechnung: eine
 *   Rechnung entsteht ausschließlich durch eine Handlung.
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
   * OHNE PREISVEREINBARUNG KEIN WECHSEL AUF `paying` ([H1]).
   *
   * Der Wechsel ist heute folgenlos — das ist die Bedingung, unter der R5 ihn
   * erlaubt. Aber `paying` ist der Status, auf dem die Rechnungen aufsetzen.
   * Ohne Preisstufe und ohne abweichenden Betrag wäre er eine Behauptung ohne
   * Grundlage. Solche Organisationen übergeht der Zeitplan;
   * `tasks/sources/price-missing` meldet sie stattdessen — vorgeschlagen
   * statt vollzogen, genau wie R5 es verlangt.
   */
  private async due(day: string): Promise<Due[]> {
    const startLimit = datePlusDays(day, -TRIAL_DAYS);

    const toPaying = await this.prisma.company.findMany({
      where: {
        status: 'trial',
        instanceStartDate: { not: null, lte: toDate(startLimit) },
        OR: [
          { priceTier: { not: null }, NOT: { priceTier: '' } },
          { customAmount: { not: null } },
        ],
      },
      select: { id: true, name: true, status: true },
    });

    return toPaying.map((row) => ({
      companyId: row.id,
      name: row.name,
      fromStatus: row.status,
      afterStatus: 'paying' as const,
      reason: `${TRIAL_DAYS} Tage nach dem Instanzstart`,
    }));
  }
}
