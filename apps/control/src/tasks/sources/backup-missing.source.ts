import { datePlusDays, dateStringFromDate, toDate } from '@saas-instant/shared';
import { BACKUP_MISSING_AFTER_DAYS } from '../../instances/instance.rules';
import { urgencyFrom } from '../urgency';
import type {
  Task,
  TasksContext,
  TaskSource,
  SourceResult,
} from '../tasks.types';

/**
 * Instanzen, für die seit zu langem keine Sicherung gemeldet wurde.
 *
 * DAS SIGNAL IST DIE STILLE. Der Auftrag benennt das Risiko genau: Scheitern
 * zeigt sich bei Sicherungen nicht als Fehlermeldung, sondern als wochenlanges
 * Nichts. Deshalb gibt es kein `status`-Feld am `Sicherung`-Modell — das
 * FEHLEN einer Zeile ist der Befund, und diese Quelle ist die Stelle, an der
 * er laut wird.
 *
 * UND DESHALB GIBT ES KEINEN GRÜNEN HAKEN: Eine Aufgabe entsteht nur im
 * Störungsfall. Eine dauerhafte Erfolgsmeldung „Sicherung in Ordnung" würde
 * nach zwei Wochen niemand mehr lesen — und dann fiele ihr Ausbleiben auch
 * nicht mehr auf (E3-18).
 */
export const backupMissing: TaskSource = {
  kind: 'backup_missing',

  async collect(context: TasksContext): Promise<SourceResult> {
    const limitDay = datePlusDays(
      context.todayDay,
      -BACKUP_MISSING_AFTER_DAYS,
    );
    const limit = toDate(limitDay);

    // Nur laufende Instanzen. Eine archivierte wird nicht mehr gesichert —
    // das ist kein Befund, sondern das Ergebnis einer Entscheidung.
    const where = {
      status: 'active' as const,
      backups: { none: { date: { gte: limit } } },
    };

    const total = await context.prisma.instance.count({ where });
    const rows = await context.prisma.instance.findMany({
      where,
      take: context.limit,
      select: {
        id: true,
        subdomain: true,
        createdAt: true,
        company: { select: { id: true, name: true, status: true } },
        backups: { orderBy: { date: 'desc' }, take: 1, select: { date: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const tasks: Task[] = rows.map((row) => {
      const last = row.backups[0];
      const lastDay =
        last === undefined ? null : dateStringFromDate(last.date);
      // Fällig war die Sicherung an dem Tag, an dem die Frist ablief.
      const dueAt = datePlusDays(
        lastDay ?? dayFrom(row.createdAt),
        BACKUP_MISSING_AFTER_DAYS,
      );
      return {
        kind: 'backup_missing',
        dueAt,
        urgency: urgencyFrom(dueAt, context.todayDay),
        title: 'Sicherung überfällig',
        reason:
          lastDay === null
            ? `Für ${row.subdomain} ist noch nie eine Sicherung gemeldet ` +
              'worden. Bitte in Coolify prüfen, ob die Sicherung eingerichtet ist.'
            : `Seit ${daysBetween(lastDay, context.todayDay)} Tagen keine ` +
              `neue Sicherung für ${row.subdomain}. Die letzte war am ` +
              `${lastDay}. Zurückgespielt wird von Hand in Coolify — ` +
              'dieses System spielt nichts ein.',
        action: {
          kind: 'company_open',
          label: 'Organisation öffnen',
          target: `/companies/${row.company.id}`,
        },
        company: {
          id: row.company.id,
          name: row.company.name,
          status: row.company.status,
        },
      };
    });
    return { tasks, total };
  },
};

/** `YYYY-MM-DD` aus einem technischen Zeitstempel. */
function dayFrom(timestamp: Date): string {
  return dateStringFromDate(
    new Date(
      Date.UTC(
        timestamp.getUTCFullYear(),
        timestamp.getUTCMonth(),
        timestamp.getUTCDate(),
      ),
    ),
  );
}

/** Ganze Tage zwischen zwei Tagesdaten, nie negativ. */
function daysBetween(from: string, until: string): number {
  const days = Math.round(
    (Date.parse(`${until}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
      86_400_000,
  );
  return days > 0 ? days : 0;
}
