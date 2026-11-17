import { dateStringFromDate } from '@saas-instant/shared';
import { urgencyFrom } from '../urgency';
import type { TasksContext, TaskSource, SourceResult } from '../tasks.types';

/**
 * Beendete Organisationen, deren Instanz noch nicht archiviert ist.
 *
 * Sie ARCHIVIERT NICHTS (R4): Archivieren sichert und stoppt die Instanz und
 * bleibt ein bewusster Klick. Die Aufgabe führt nur zur Organisation. Fällig
 * ist sie ab dem Tag des Statuswechsels.
 */
export const instanceStillActive: TaskSource = {
  kind: 'instance_still_active',

  async collect(context: TasksContext): Promise<SourceResult> {
    const where = {
      status: 'ended' as const,
      instance: { is: { status: { not: 'archived' as const } } },
    };

    const [rows, total] = await Promise.all([
      context.prisma.company.findMany({
        where,
        select: { id: true, name: true, status: true, lastStatusChangeAt: true },
        orderBy: { lastStatusChangeAt: 'asc' },
        take: context.limit,
      }),
      context.prisma.company.count({ where }),
    ]);

    return {
      total,
      tasks: rows.map((row) => {
        const dueAt =
          row.lastStatusChangeAt === null
            ? context.todayDay
            : dateStringFromDate(row.lastStatusChangeAt);
        return {
          kind: 'instance_still_active' as const,
          dueAt,
          urgency: urgencyFrom(dueAt, context.todayDay),
          title: `Instanz von ${row.name} noch aktiv`,
          reason:
            'Die Organisation ist beendet, ihre Instanz ist aber nicht ' +
            'archiviert. Archivieren sichert und stoppt sie; das geschieht ' +
            'nur auf deinen Klick.',
          action: {
            kind: 'company_open' as const,
            label: 'Instanz archivieren',
            target: `/companies/${row.id}`,
          },
          company: { id: row.id, name: row.name, status: row.status },
        };
      }),
    };
  },
};
