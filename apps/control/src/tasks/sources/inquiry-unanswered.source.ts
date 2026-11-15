import { datePlusDays, dateStringFromDate } from '@saas-instant/shared';
import { urgencyFrom } from '../urgency';
import type {
  Task,
  TasksContext,
  TaskSource,
  SourceResult,
} from '../tasks.types';

/** Nach so vielen Stunden ohne Reaktion wird aus einer Anfrage eine Aufgabe. */
export const REACTION_DEADLINE_HOURS = 24;

/**
 * Anfragen, auf die seit mehr als 24 Stunden niemand reagiert hat.
 *
 * WAS ALS REAKTION ZÄHLT: ein Statuswechsel oder eine SELBST ERFASSTE Notiz.
 * Systemerzeugte Notizen zählen ausdrücklich NICHT — sonst hätte eine zweite
 * Anfrage derselben Person die Aufgabe zum Verschwinden gebracht, obwohl
 * niemand geantwortet hat. Genau das legt der öffentliche Anfrageweg bei einer
 * Dublette an.
 *
 * Die einzige Regel mit Stundengenauigkeit. Sie stützt sich deshalb auf
 * `createdAt` (technischer Zeitstempel), nicht auf ein Tagesdatum.
 */
export const inquiryUnanswered: TaskSource = {
  kind: 'inquiry_unanswered',

  async collect(context: TasksContext): Promise<SourceResult> {
    const cutoffDate = new Date(
      context.now.getTime() - REACTION_DEADLINE_HOURS * 60 * 60 * 1000,
    );
    const where = {
      status: 'inquiry' as const,
      createdAt: { lt: cutoffDate },
      lastStatusChangeAt: null,
      noteEntries: { none: { bySystem: false } },
    };

    const [rows, total] = await Promise.all([
      context.prisma.company.findMany({
        where,
        select: { id: true, name: true, status: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: context.limit,
      }),
      context.prisma.company.count({ where }),
    ]);

    const tasks = rows.map((row) => {
      // Fällig war sie am Tag nach dem Eingang.
      const dueAt = datePlusDays(dateStringFromDate(row.createdAt), 1);
      return {
        kind: 'inquiry_unanswered' as const,
        dueAt,
        urgency: urgencyFrom(dueAt, context.todayDay),
        title: `Anfrage von ${row.name} ist unbeantwortet`,
        reason:
          `Seit dem Eingang sind mehr als ${REACTION_DEADLINE_HOURS} Stunden ` +
          'vergangen, ohne Statuswechsel und ohne eigene Notiz.',
        action: {
          kind: 'company_open' as const,
          label: 'Anfrage bearbeiten',
          target: `/companies/${row.id}`,
        },
        company: { id: row.id, name: row.name, status: row.status },
      };
    });
    return { tasks, total };
  },
};
