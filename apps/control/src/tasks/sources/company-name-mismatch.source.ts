import { dateStringFromDate } from '@saas-instant/shared';
import { urgencyFrom } from '../urgency';
import type {
  Task,
  TasksContext,
  TaskSource,
  SourceResult,
} from '../tasks.types';

/**
 * Der Organisationsname IN DER INSTANZ passt nicht mehr zum Vertragsnamen.
 *
 * WAS HIER VORHER GEMESSEN WURDE — und warum es das Falsche war ([W3]):
 * Die erste Fassung verglich `subdomainVorschlag(CRM-Name)` mit der laufenden
 * Subdomain. Das findet den Fall, dass jemand die Subdomain frei gewählt hat —
 * also eine Entscheidung, die meistens richtig ist. Den Fall, für den E3-20
 * existiert, findet es NICHT: Der Verein firmiert IN SEINER INSTANZ um, das
 * CRM führt weiter den alten Vertragsnamen, und die Subdomain bleibt, wie sie
 * ist. Genau dann stimmen Rechnung und Vertrag nicht mehr, und genau dann
 * meldete die alte Fassung nichts.
 *
 * WIE ES JETZT GEMESSEN WIRD, ohne E3-3 zu verletzen: Der tägliche
 * Kennzahlen-Abruf schickt einen ABDRUCK des erwarteten Namens mit; die
 * Instanz antwortet mit ja oder nein. Ein Wahrheitswert ist kein Inhalt — über
 * die Leitung geht in keiner Richtung ein Name, und der Satz im AV-Vertrag
 * bleibt wahr.
 *
 * ES WIRD NICHTS ÜBERSCHRIEBEN (E3-20). Weder der Name im CRM noch der in der
 * Instanz. Die Handlung öffnet die Organisation, mehr nicht.
 *
 * `null` HEISST NICHT `false`: Eine Instanz, die noch nie geantwortet hat oder
 * auf einem älteren Stand läuft, meldet „nicht gemessen". Daraus eine
 * Abweichung zu machen, wäre eine Behauptung über etwas, das niemand geprüft
 * hat.
 */
export const companyNameMismatch: TaskSource = {
  kind: 'company_name_mismatch',

  async collect(context: TasksContext): Promise<SourceResult> {
    const instances = await context.prisma.instance.findMany({
      where: { status: 'active' },
      select: {
        subdomain: true,
        company: { select: { id: true, name: true, status: true } },
        // Die JÜNGSTE erfolgreiche Zeile. Nur sie sagt etwas über den Namen —
        // eine gescheiterte Abfrage hat nichts gemessen.
        metrics: {
          where: { fetchSuccessful: true },
          orderBy: { date: 'desc' },
          take: 1,
          select: { date: true, companyNameMatches: true },
        },
      },
      orderBy: { subdomain: 'asc' },
    });

    const affected = instances.filter(
      (row) => row.metrics[0]?.companyNameMatches === false,
    );

    const tasks: Task[] = affected
      .slice(0, context.limit)
      .map((row) => {
        // Fällig seit dem Tag, an dem die Abweichung gemessen wurde. Wann sie
        // entstanden ist, weiss das CRM nicht — und ein erfundenes Datum wäre
        // schlechter als ein belegbares.
        const dueAt = dateStringFromDate(row.metrics[0].date);
        return {
          kind: 'company_name_mismatch' as const,
          dueAt,
          urgency: urgencyFrom(dueAt, context.todayDay),
          title: 'Organisationsname weicht von der Instanz ab',
          reason:
            `Die Instanz ${row.subdomain} führt einen anderen ` +
            `Organisationsnamen als der Vertrag („${row.company.name}"). ` +
            'Der Name selbst wird nicht übertragen — verglichen wurde ein ' +
            'Abdruck. Bitte prüfen, ob Vertrag und Rechnung noch stimmen; ' +
            'automatisch wird nichts überschrieben.',
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
