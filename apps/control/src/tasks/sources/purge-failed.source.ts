import type { Prisma } from '.prisma/control-client';
import { dateStringFromDate, datePlusDays, deletionDay } from '@saas-instant/shared';
import { dueArchive, endedCompany } from '../../instances/expired-archive';
import { urgencyFrom } from '../urgency';
import type { TasksContext, TaskSource, SourceResult } from '../tasks.types';

/** Karenz: so viele Tage nach der Frist darf die nächtliche Löschung noch auf den Sicherungs-Agenten warten. */
const GRACE_DAYS = 2;

/**
 * Archivierte Instanzen, die über die Löschfrist (`PURGE_DAYS`) hinaus noch da
 * sind: Coolify (Löschrecht des Tokens), der Sicherungs-Agent oder die
 * Organisation hängen — oder die Organisation ist nicht beendet und wird
 * deshalb nicht gelöscht (`expiredArchive`). Die Aufgabe LÖSCHT NICHTS; der Grund steht im
 * Audit-Log (`instance.purge.failure`), die nächste Nacht versucht es erneut.
 */
export const purgeFailed: TaskSource = {
  kind: 'purge_failed',

  async collect(context: TasksContext): Promise<SourceResult> {
    const graceDay = datePlusDays(context.todayDay, -GRACE_DAYS);
    // Nicht beendete Organisationen (werden nie gelöscht) und löschbare, die hängen. Eine erst kürzlich beendete wartet nur.
    const where: Prisma.InstanceWhereInput = {
      ...dueArchive(graceDay),
      OR: [{ company: { status: { not: 'ended' } } }, endedCompany(graceDay)],
    };
    const [rows, total] = await Promise.all([
      context.prisma.instance.findMany({
        where,
        select: {
          subdomain: true,
          archivedAt: true,
          company: { select: { id: true, name: true, status: true, endedAt: true } },
        },
        orderBy: { archivedAt: 'asc' },
        take: context.limit,
      }),
      context.prisma.instance.count({ where }),
    ]);

    return {
      total,
      tasks: rows.map((row) => {
        // Wie bei der Löschung: die spätere der beiden Fristen zählt.
        const dueAt = [row.archivedAt as Date, row.company.endedAt]
          .filter((date): date is Date => date !== null)
          .map((date) => deletionDay(dateStringFromDate(date)))
          .sort()
          .pop() as string;
        return {
          kind: 'purge_failed' as const,
          dueAt,
          urgency: urgencyFrom(dueAt, context.todayDay),
          title: `Löschung von ${row.company.name} fehlgeschlagen`,
          reason:
            row.company.status !== 'ended'
              ? `Die Instanz ${row.subdomain} sollte am ${dueAt} gelöscht werden. Die Organisation ist nicht beendet, ` +
                'deshalb wird nichts gelöscht. Setze den Status auf „Beendet“, dann löscht der nächste Nachtlauf.'
              : `Die Instanz ${row.subdomain} sollte am ${dueAt} gelöscht werden und ist noch da. ` +
                'Prüfe, ob das Coolify-Token das Löschrecht hat und der Sicherungs-Agent läuft; ' +
                'der Grund steht im Protokoll. Die Löschung wird nachts wiederholt.',
          action: {
            kind: 'company_open' as const,
            label: 'Organisation öffnen',
            target: `/companies/${row.company.id}`,
          },
          company: { id: row.company.id, name: row.company.name, status: row.company.status },
        };
      }),
    };
  },
};
