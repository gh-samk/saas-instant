import { dateStringFromDate, toDate } from '@saas-instant/shared';
import { AUDIT_ACTION } from '../../audit/audit.service';
import { statusLabelOf } from '../../companies/status-label';
import { urgencyFrom } from '../urgency';
import type {
  Task,
  TasksContext,
  TaskSource,
  SourceResult,
} from '../tasks.types';

/**
 * Statuswechsel, die der Zeitplan seit dem letzten Blick von allein vollzogen
 * hat.
 *
 * QUELLE IST DAS AUDIT-LOG, nicht die Organisation selbst: nur dort steht,
 * WANN und von WEM gewechselt wurde. `lastStatusChangeAt` an der
 * Organisation sagt nicht, ob eine Person oder der Zeitplan gehandelt hat —
 * genau das ist hier aber die Aussage.
 *
 * „Seit dem letzten Blick" kommt vom Aufrufer (`since`). Ein Feld dafür gibt es
 * im Datenmodell nicht; ohne Schemaänderung ist das der ehrlichste Weg.
 */
export const statusChangeAutomatic: TaskSource = {
  kind: 'status_change_automatic',

  async collect(context: TasksContext): Promise<SourceResult> {
    const where = {
      action: AUDIT_ACTION.companyStatusAutomatic,
      timestamp: { gte: toDate(context.since) },
      objectId: { not: null },
    };
    const [entries, total] = await Promise.all([
      context.prisma.auditLog.findMany({
        where,
        select: {
          objectId: true,
          timestamp: true,
          beforeValue: true,
          afterValue: true,
        },
        orderBy: { timestamp: 'desc' },
        take: context.limit,
      }),
      context.prisma.auditLog.count({ where }),
    ]);
    if (entries.length === 0) return { tasks: [], total };

    const identifiers = [
      ...new Set(
        entries.flatMap((e) => (e.objectId === null ? [] : [e.objectId])),
      ),
    ];
    const companies = await context.prisma.company.findMany({
      where: { id: { in: identifiers } },
      select: { id: true, name: true, status: true },
    });
    const afterIdentifier = new Map(companies.map((o) => [o.id, o]));

    const tasks = entries.flatMap((entry) => {
      const company =
        entry.objectId === null ? undefined : afterIdentifier.get(entry.objectId);
      // Der Nachweis überlebt sein Bezugsobjekt; die Aufgabe braucht es aber.
      if (!company) return [];

      const dueAt = dateStringFromDate(
        new Date(
          Date.UTC(
            entry.timestamp.getFullYear(),
            entry.timestamp.getMonth(),
            entry.timestamp.getDate(),
          ),
        ),
      );
      const from = statusFrom(entry.beforeValue);
      const after = statusFrom(entry.afterValue);

      return [
        {
          kind: 'status_change_automatic' as const,
          dueAt,
          urgency: urgencyFrom(dueAt, context.todayDay),
          title: `${company.name}: Status hat sich von allein geändert`,
          reason:
            from && after
              ? `Der Zeitplan hat den Status von „${from}" auf „${after}" gesetzt.`
              : 'Der Zeitplan hat den Status gesetzt.',
          action: {
            kind: 'company_open' as const,
            label: 'Änderung ansehen',
            target: `/companies/${company.id}`,
          },
          company,
        },
      ];
    });
    return { tasks, total };
  },
};

/** Liest den Status aus einem Audit-Wert, ohne einem JSON-Feld zu vertrauen. */
function statusFrom(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const status = (value as Record<string, unknown>)['status'];
  if (typeof status !== 'string') return null;
  return statusLabelOf(status);
}
