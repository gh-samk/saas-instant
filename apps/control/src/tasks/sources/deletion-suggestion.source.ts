import { dateStringFromDate, toDate } from '@saas-instant/shared';
import { datePlusMonths } from '../../common/calendar';
import { urgencyFrom } from '../urgency';
import type {
  Task,
  TasksContext,
  TaskSource,
  SourceResult,
} from '../tasks.types';

/** Nach so vielen Monaten ohne Kontakt wird die Löschung VORGESCHLAGEN. */
export const RETENTION_MONTHS = 24;

/**
 * Anfragen ohne Abschluss, zu denen seit 24 Monaten kein Kontakt mehr
 * bestand.
 *
 * DIESE QUELLE LÖSCHT NICHTS (R4). Sie erzeugt einen Vorschlag, den ein Mensch
 * annimmt oder verwirft. Es gibt in dieser Etappe bewusst auch keinen
 * Endpunkt, der die Löschung ausführen würde — eine automatische Frist darf
 * niemals unmittelbar Daten entfernen.
 *
 * „Ohne Abschluss" heißt: der Status steht immer noch auf `inquiry`. Wer je
 * eine Demo bekommen oder einen Piloten beschlossen hat, fällt nicht hierunter.
 */
export const deletionSuggestion: TaskSource = {
  kind: 'deletion_suggestion',

  async collect(context: TasksContext): Promise<SourceResult> {
    const limitDay = datePlusMonths(context.todayDay, -RETENTION_MONTHS);
    const limit = toDate(limitDay);
    const where = {
      status: 'inquiry' as const,
      createdAt: { lt: limit },
      OR: [
        { lastStatusChangeAt: null },
        { lastStatusChangeAt: { lte: limit } },
      ],
      noteEntries: { none: { date: { gt: limit } } },
    };

    const total = await context.prisma.company.count({ where });
    const rows = await context.prisma.company.findMany({
      where,
      take: context.limit,
      select: {
        id: true,
        name: true,
        status: true,
        createdAt: true,
        lastStatusChangeAt: true,
        noteEntries: {
          select: { date: true },
          orderBy: { date: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const tasks = rows.map((row) => {
      const lastContact = latest([
        dateStringFromDate(
          new Date(
            Date.UTC(
              row.createdAt.getUTCFullYear(),
              row.createdAt.getUTCMonth(),
              row.createdAt.getUTCDate(),
            ),
          ),
        ),
        row.lastStatusChangeAt === null
          ? null
          : dateStringFromDate(row.lastStatusChangeAt),
        row.noteEntries[0]
          ? dateStringFromDate(row.noteEntries[0].date)
          : null,
      ]);
      const dueAt = datePlusMonths(lastContact, RETENTION_MONTHS);

      return {
        kind: 'deletion_suggestion' as const,
        dueAt,
        urgency: urgencyFrom(dueAt, context.todayDay),
        title: `Kontaktdaten von ${row.name} prüfen`,
        reason:
          `Seit ${RETENTION_MONTHS} Monaten kein Kontakt und kein ` +
          'Abschluss. Vorschlag: Kontaktdaten löschen — entschieden wird das ' +
          'von Hand, automatisch löscht hier nichts.',
        action: {
          kind: 'deletion_check' as const,
          label: 'Löschung prüfen',
          target: `/companies/${row.id}`,
        },
        company: { id: row.id, name: row.name, status: row.status },
      };
    });
    return { tasks, total };
  },
};

/** Der späteste von mehreren Tagen; `null`-Werte werden übergangen. */
function latest(days: (string | null)[]): string {
  const existing = days.filter((day): day is string => day !== null).sort();
  const last = existing[existing.length - 1];
  // Mindestens `createdAt` ist immer dabei.
  if (last === undefined) throw new Error('Kein Kontaktdatum vorhanden.');
  return last;
}
