import { datePlusDays, dateStringFromDate, toDate } from '@saas-instant/shared';
import { urgencyFrom } from '../urgency';
import type {
  Task,
  TasksContext,
  TaskSource,
  SourceResult,
} from '../tasks.types';

/**
 * Ab wie vielen Tagen ohne erfolgreiche Abfrage eine Aufgabe entsteht.
 *
 * Zwei Tage, nicht einer: Der Abruf läuft nachts um vier. Ein einzelner
 * ausgefallener Lauf — Wartungsfenster, Neustart, kurzer Netzausfall — soll
 * nicht jedes Mal eine Aufgabe erzeugen. Bleibt es zwei Tage still, ist es
 * keine Zufälligkeit mehr.
 */
export const METRICS_MISSING_FROM_DAYS = 2;

/**
 * Instanzen, deren Kennzahlen-Abfrage seit mehreren Tagen fehlschlägt.
 *
 * FEHLSCHLÄGE WERDEN GEMELDET, NICHT VERSCHLUCKT (E3-7). Der Abruf schreibt
 * auch den gescheiterten Versuch als `Kennzahl`-Zeile
 * (`fetchSuccessful: false`); hier wird daraus eine sichtbare Aufgabe.
 *
 * WARUM BEDENKEN UND NICHT EINWAND: Eine ausbleibende Kennzahlen-Antwort
 * blockiert im CRM nichts — Notizen, Statuswechsel und Rechnungen laufen
 * unverändert weiter, nur das Bild der Nutzung ist veraltet. Die Dringlichkeit
 * kommt deshalb wie bei jeder anderen Art allein aus der Fälligkeit.
 */
export const metricsQueryFailed: TaskSource = {
  kind: 'metrics_query_failed',

  async collect(context: TasksContext): Promise<SourceResult> {
    const limitDay = datePlusDays(context.todayDay, -METRICS_MISSING_FROM_DAYS);
    const limit = toDate(limitDay);

    // Eine Instanz ist auffällig, wenn es seit der Grenze KEINE erfolgreiche
    // Zeile gibt, aber mindestens einen Versuch — sonst wäre auch eine
    // Instanz betroffen, die gerade erst angelegt wurde und noch nie
    // abgefragt wurde.
    const where = {
      status: 'active' as const,
      metrics: {
        none: { fetchSuccessful: true, date: { gte: limit } },
        some: {},
      },
    };

    const total = await context.prisma.instance.count({ where });
    const rows = await context.prisma.instance.findMany({
      where,
      take: context.limit,
      select: {
        id: true,
        subdomain: true,
        company: { select: { id: true, name: true, status: true } },
        metrics: {
          where: { fetchSuccessful: true },
          orderBy: { date: 'desc' },
          take: 1,
          select: { date: true },
        },
      },
      orderBy: { subdomain: 'asc' },
    });

    const tasks: Task[] = rows.map((row) => {
      const lastSuccess = row.metrics[0];
      const lastDay =
        lastSuccess === undefined
          ? null
          : dateStringFromDate(lastSuccess.date);
      // Fällig ab dem Tag nach der letzten erfolgreichen Abfrage — bei einer
      // Instanz, die noch nie geantwortet hat, ab der Grenze selbst.
      const dueAt =
        lastDay === null ? limitDay : datePlusDays(lastDay, 1);
      const days =
        lastDay === null ? null : daysBetween(lastDay, context.todayDay);
      return {
        kind: 'metrics_query_failed',
        dueAt,
        urgency: urgencyFrom(dueAt, context.todayDay),
        title: 'Kennzahlen-Abfrage schlägt fehl',
        reason:
          days === null
            ? `Von ${row.subdomain} kam noch nie eine erfolgreiche Antwort. ` +
              'Meist fehlt die Umgebungsvariable METRICS_TOKEN auf der Instanz.'
            : `Seit ${days} Tagen keine erfolgreiche Abfrage von ` +
              `${row.subdomain}. Zuletzt erfolgreich am ${lastDay}.`,
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

function daysBetween(from: string, until: string): number {
  const days = Math.round(
    (Date.parse(`${until}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
      86_400_000,
  );
  return days > 0 ? days : 0;
}
