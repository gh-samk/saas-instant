import { datePlusDays, dateStringFromDate, toDate } from '@saas-instant/shared';
import { urgencyFrom } from '../urgency';
import type {
  Task,
  TasksContext,
  TaskSource,
  SourceResult,
} from '../tasks.types';

/** So weit im Voraus wird der Überprüfungstermin gemeldet. */
export const PREVIEW_DAYS = 30;

/**
 * Überprüfungstermine, die binnen 30 Tagen anstehen oder überfällig sind.
 *
 * Beendete und ruhende Organisationen bleiben außen vor — dort gibt es nichts
 * zu überprüfen. Organisationen, die der Zeitplan bereits auf
 * `review_pending` gesetzt hat, bleiben ausdrücklich DRIN: sie sind der
 * eigentliche Grund für die Aufgabe.
 */
export const reviewDate: TaskSource = {
  kind: 'review_date',

  async collect(context: TasksContext): Promise<SourceResult> {
    const until = datePlusDays(context.todayDay, PREVIEW_DAYS);
    const where = {
      reviewDueDate: { not: null, lte: toDate(until) },
      status: { notIn: ['ended' as const, 'dormant' as const] },
    };

    const [rows, total] = await Promise.all([
      context.prisma.company.findMany({
        where,
        select: {
          id: true,
          name: true,
          status: true,
          reviewDueDate: true,
        },
        orderBy: { reviewDueDate: 'asc' },
        take: context.limit,
      }),
      context.prisma.company.count({ where }),
    ]);

    const tasks = rows.flatMap((row) => {
      if (row.reviewDueDate === null) return [];
      const dueAt = dateStringFromDate(row.reviewDueDate);
      return [
        {
          kind: 'review_date' as const,
          dueAt,
          urgency: urgencyFrom(dueAt, context.todayDay),
          title: `Überprüfung mit ${row.name} ansetzen`,
          reason:
            'Sieben Monate nach dem Pilotbeschluss steht die gemeinsame ' +
            'Überprüfung an.',
          action: {
            kind: 'company_open' as const,
            label: 'Überprüfung vorbereiten',
            target: `/companies/${row.id}`,
          },
          company: { id: row.id, name: row.name, status: row.status },
        },
      ];
    });
    return { tasks, total };
  },
};
