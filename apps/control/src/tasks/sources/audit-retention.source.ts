import { dateStringFromDate } from '@saas-instant/shared';
import { datePlusMonths } from '../../common/calendar';
import { urgencyFrom } from '../urgency';
import type {
  TasksContext,
  TaskSource,
  SourceResult,
} from '../tasks.types';

/** Aufbewahrungsfrist des Audit-Logs in Monaten (drei Jahre). */
export const AUDIT_RETENTION_MONTHS = 36;

/**
 * Audit-Zeilen, die älter sind als die Aufbewahrungsfrist ([W5]).
 *
 * Die Frist stand bisher nirgends — weder als Umsetzung noch als Handgriff
 * noch als Aufgabe. Damit wuchs der Nachweis unbegrenzt, und die zugesagte
 * Löschung nach drei Jahren war eine Behauptung.
 *
 * DIESE QUELLE LÖSCHT NICHTS (R4). Sie meldet, dass etwas ansteht, und nennt
 * den Handgriff. Bewusst kein Endpunkt und kein Job dafür: Das Audit-Log ist
 * der Nachweis; was ihn kürzt, muss ein Mensch auslösen und verantworten. Der
 * Handgriff steht in der Begründung, damit er dort steht, wo er gebraucht
 * wird.
 *
 * EINE Aufgabe für den ganzen Bestand, deshalb ohne Organisationsbezug.
 */
export const auditRetention: TaskSource = {
  kind: 'audit_retention',

  async collect(context: TasksContext): Promise<SourceResult> {
    const limitDay = datePlusMonths(
      context.todayDay,
      -AUDIT_RETENTION_MONTHS,
    );
    const limit = new Date(`${limitDay}T00:00:00.000Z`);

    const [count, oldest] = await Promise.all([
      context.prisma.auditLog.count({ where: { timestamp: { lt: limit } } }),
      context.prisma.auditLog.findFirst({
        where: { timestamp: { lt: limit } },
        orderBy: { timestamp: 'asc' },
        select: { timestamp: true },
      }),
    ]);
    if (count === 0 || oldest === null) return { tasks: [], total: 0 };

    // Fällig wurde die Frist an dem Tag, an dem die älteste Zeile drei Jahre
    // alt wurde.
    const dueAt = datePlusMonths(
      dateStringFromDate(
        new Date(
          Date.UTC(
            oldest.timestamp.getUTCFullYear(),
            oldest.timestamp.getUTCMonth(),
            oldest.timestamp.getUTCDate(),
          ),
        ),
      ),
      AUDIT_RETENTION_MONTHS,
    );

    return {
      total: 1,
      tasks: [
        {
          kind: 'audit_retention',
          dueAt,
          urgency: urgencyFrom(dueAt, context.todayDay),
          title: `${count} Audit-Einträge sind älter als drei Jahre`,
          reason:
            `Die Aufbewahrungsfrist beträgt ${AUDIT_RETENTION_MONTHS} ` +
            'Monate. Automatisch wird davon nichts gelöscht (R4) — der ' +
            'Handgriff läuft im Container und ist zu verantworten: ' +
            'docker compose exec control-db psql -U <DB-Benutzer> ' +
            '-d <DB-Name> -c \'DELETE FROM "AuditLog" WHERE ' +
            `"zeitpunkt" < now() - interval '${AUDIT_RETENTION_MONTHS} ` +
            "months'\". Vorher ein Backup ziehen.",
          action: {
            kind: 'retention_check',
            label: 'Aufbewahrung prüfen',
            target: '/settings',
          },
        },
      ],
    };
  },
};
