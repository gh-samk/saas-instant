import { datePlusDays, dateStringFromDate, toDate } from '@saas-instant/shared';
import { NO_ENTRY_DAYS } from '../../instances/instance.rules';
import { urgencyFrom } from '../urgency';
import type {
  Task,
  TasksContext,
  TaskSource,
  SourceResult,
} from '../tasks.types';

/**
 * SEIT 45 TAGEN KEIN EINTRAG — laut Auftragsdokument die geschäftlich
 * wichtigste Zeile der Anwendung.
 *
 * Der Grund steht dort wörtlich: „Abwanderung entsteht bei diesem Produkt
 * nicht durch den Preis, sondern durch Nichtnutzung." Ein Kunde, der seit
 * sechs Wochen nichts protokolliert, kündigt nicht heute — er kündigt in
 * einem halben Jahr, und dann ist es zu spät für ein Gespräch.
 *
 * KEIN OPTISCHER SONDERFALL, und das ist Absicht. Das Gewicht kommt aus der
 * Fälligkeit selbst: 45 Tage ohne Eintrag ist bereits ein spätes Signal, also
 * liegt `dueAt` in dem Moment, in dem die Aufgabe entsteht, schon in der
 * Vergangenheit. Sie erscheint damit von der ersten Sekunde an als überfällig
 * und wandert durch die bestehende Sortierung von selbst nach oben — nicht
 * weil ihre Art besonders markiert wäre, sondern weil ihre Fälligkeit es
 * verlangt. Genau wie bei jeder anderen Aufgabe.
 */
export const noEntryForLong: TaskSource = {
  kind: 'no_entry_for_long',

  async collect(context: TasksContext): Promise<SourceResult> {
    const limitDay = datePlusDays(context.todayDay, -NO_ENTRY_DAYS);
    const limit = toDate(limitDay);

    // Gelesen wird die JÜNGSTE ERFOLGREICHE Kennzahl je Instanz. Eine
    // Datenbankabfrage kann „das jüngste Kind erfüllt Bedingung X" in Prisma
    // nicht ausdrücken; die Kandidatenmenge ist aber die Zahl der aktiven
    // Instanzen und damit klein.
    const instances = await context.prisma.instance.findMany({
      where: { status: 'active' },
      select: {
        id: true,
        subdomain: true,
        company: { select: { id: true, name: true, status: true } },
        metrics: {
          where: { fetchSuccessful: true },
          orderBy: { date: 'desc' },
          take: 1,
          select: { lastEntryAt: true },
        },
      },
    });

    const affected = instances
      .map((row) => ({
        row,
        lastEntry: row.metrics[0]?.lastEntryAt ?? null,
      }))
      // Ohne erfolgreiche Kennzahl wissen wir NICHTS über die Nutzung. Das
      // wäre keine Nichtnutzung, sondern eine fehlende Messung — dafür gibt
      // es die Quelle `kennzahlen_abfrage_fehlgeschlagen`.
      .filter((e) => e.lastEntry !== null)
      .filter((e) => (e.lastEntry as Date).getTime() <= limit.getTime())
      .sort(
        (a, b) =>
          (a.lastEntry as Date).getTime() -
          (b.lastEntry as Date).getTime(),
      );

    const tasks: Task[] = affected
      .slice(0, context.limit)
      .map(({ row, lastEntry }) => {
        const lastDay = dateStringFromDate(lastEntry as Date);
        const dueAt = datePlusDays(lastDay, NO_ENTRY_DAYS);
        const days = daysBetween(lastDay, context.todayDay);
        return {
          kind: 'no_entry_for_long' as const,
          dueAt,
          urgency: urgencyFrom(dueAt, context.todayDay),
          title: `Seit ${days} Tagen kein Eintrag`,
          reason:
            `In ${row.subdomain} wurde seit dem ${lastDay} nichts mehr ` +
            'protokolliert. Nichtnutzung ist bei diesem Produkt der Weg zur ' +
            'Kündigung — ein Anruf lohnt sich jetzt, nicht bei der Verlängerung.',
          action: {
            kind: 'company_open' as const,
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

    return { tasks, total: affected.length };
  },
};

function daysBetween(from: string, until: string): number {
  const days = Math.round(
    (Date.parse(`${until}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
      86_400_000,
  );
  return days > 0 ? days : 0;
}
