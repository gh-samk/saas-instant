import { datePlusDays, dateStringFromDate, toDate } from '@saas-instant/shared';
import {
  averageActivePersons,
  tierFor,
} from '../../invoices/pricing.tier';
import type { PriceTier } from '../../invoices/pricing.types';
import { urgencyFrom } from '../urgency';
import type {
  Task,
  TasksContext,
  TaskSource,
  SourceResult,
} from '../tasks.types';

/**
 * Zahlende Organisationen, deren gemessene Größe nicht mehr zur vereinbarten
 * Preisstufe passt.
 *
 * SIE ÄNDERT KEINE PREISVEREINBARUNG (R5). Diese Datei schreibt nichts. Sie
 * legt die Abweichung vor, die Betreiberin entscheidet — und zwar mit der
 * Grundlage vor Augen: Durchschnitt, Zahl der Messtage und Zeitraum stehen in
 * der Begründung. Ein Vorschlag, dessen Grundlage man nicht sieht, ist keine
 * Entscheidungshilfe.
 *
 * BEIDE RICHTUNGEN. Der Auftrag nennt den Fall „Instanz wächst über die
 * Stufe". Gemeldet wird trotzdem auch die Gegenrichtung, weil die Aufgabe
 * „Stufe PRÜFEN" heißt und nicht „Stufe erhöhen": Eine Organisation, die
 * geschrumpft ist, zahlt zu viel. Das stillschweigend zu übergehen, wäre eine
 * Entscheidung zugunsten des eigenen Hauses, getroffen von einer
 * Aufgabenliste.
 *
 * KEINE AUFGABE BEI ABWEICHENDEM BETRAG: Wer einen ausgehandelten Preis hat
 * (ermäßigte Instanz), hat die Stufe bewusst verlassen. Die Schwelle über ihn
 * hinweg zu melden, hieße eine Vereinbarung anzuzweifeln, die es so geben
 * soll.
 *
 * DIE MESSTAGE STEHEN DABEI, WEIL SIE DIE AUSSAGE TRAGEN. Gescheiterte
 * Kennzahlen-Abfragen gehen nicht in den Durchschnitt ein (siehe
 * `preis.stufe.ts`) — bei einer Woche Netzstörung beruht die Abweichung
 * womöglich auf drei Messungen. Wer das sieht, wartet ab, statt umzustufen.
 */
export const tierCheck: TaskSource = {
  kind: 'tier_check',

  async collect(context: TasksContext): Promise<SourceResult> {
    const candidates = await context.prisma.company.findMany({
      where: {
        status: 'paying',
        priceTier: { not: null },
        customAmount: null,
        instance: { isNot: null },
      },
      select: {
        id: true,
        name: true,
        status: true,
        priceTier: true,
        instance: { select: { id: true } },
      },
    });
    // Der Name ist verschluesselt: im Speicher sortieren.
    candidates.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    if (candidates.length === 0) return { total: 0, tasks: [] };

    // Derselbe Zeitraum wie beim Preisvorschlag: er endet HEUTE und umfasst
    // `averageDays` Tage. Die Schwellen kommen aus derselben Preistafel,
    // die auch die Rechnung benutzt — geraten wird hier nichts.
    const from = datePlusDays(
      context.todayDay,
      -(context.priceTable.averageDays - 1),
    );

    // EINE Abfrage für alle Instanzen statt einer je Organisation. Bei
    // neunzig Tagen und einer Zeile je Tag ist das die Größenordnung, in der
    // ein N+1 auf der Startseite spürbar wird.
    const measurements = await context.prisma.metric.findMany({
      where: {
        instanceId: { in: candidates.map((k) => k.instance!.id) },
        date: { gte: toDate(from), lte: toDate(context.todayDay) },
        fetchSuccessful: true,
      },
      select: { instanceId: true, date: true, activePersons: true },
    });

    const perInstance = new Map<string, { values: (number | null)[]; last: Date }>();
    for (const row of measurements) {
      const entry = perInstance.get(row.instanceId);
      if (entry === undefined) {
        perInstance.set(row.instanceId, {
          values: [row.activePersons],
          last: row.date,
        });
      } else {
        entry.values.push(row.activePersons);
        if (row.date > entry.last) entry.last = row.date;
      }
    }

    const differing = candidates.flatMap((row) => {
      const measured = perInstance.get(row.instance!.id);
      if (measured === undefined) return [];

      const { average, measurementDays } = averageActivePersons(
        measured.values,
      );
      if (average === null) return [];

      const matching = tierFor(average, context.priceTable.tiers);
      // Keine passende Stufe heisst: die Preistafel deckt diese Grösse nicht
      // ab. Das ist ein Mangel der Tafel und keine Aussage ueber den Kunden —
      // hier waere jede Empfehlung geraten.
      if (matching === null || matching.key === row.priceTier) return [];

      const agreed = context.priceTable.tiers.find(
        (s: PriceTier) => s.key === row.priceTier,
      );
      // Eine vereinbarte Stufe, die es in der Tafel nicht mehr gibt, ist eine
      // eigene Geschichte (umbenannte oder entfallene Stufe). Sie hier als
      // „zu niedrig" oder „zu hoch" zu melden, waere eine Behauptung ueber
      // eine Ordnung, die nicht mehr besteht.
      if (agreed === undefined) return [];

      const higher =
        (agreed.maxPersons ?? Number.POSITIVE_INFINITY) <
        (matching.maxPersons ?? Number.POSITIVE_INFINITY);

      // Fällig seit dem Tag der jüngsten Messung, die in den Durchschnitt
      // eingeht — dasselbe Vorgehen wie bei `organisationsname_abweichung`:
      // ein belegbares Datum statt eines erfundenen.
      const dueAt = dateStringFromDate(measured.last);

      return [
        {
          kind: 'tier_check' as const,
          dueAt,
          urgency: urgencyFrom(dueAt, context.todayDay),
          title: `Preisstufe von ${row.name} prüfen`,
          reason:
            `Vereinbart ist „${agreed.label}", gemessen wurden im ` +
            `Durchschnitt ${round(average)} aktive Personen an ` +
            `${measurementDays} von ${context.priceTable.averageDays} Tagen — ` +
            `das entspricht „${matching.label}". Die Instanz ist damit ` +
            (higher
              ? 'über die vereinbarte Stufe gewachsen.'
              : 'kleiner als die vereinbarte Stufe; die Organisation zahlt ' +
                'derzeit zu viel.') +
            ' Geändert wird nichts (R5) — die Preisvereinbarung fasst nur an, ' +
            'wer sie auch verantwortet.',
          action: {
            kind: 'price_agree' as const,
            label: 'Preisstufe prüfen',
            target: `/companies/${row.id}`,
          },
          company: { id: row.id, name: row.name, status: row.status },
        },
      ];
    });

    return {
      total: differing.length,
      tasks: differing.slice(0, context.limit) as Task[],
    };
  },
};

/** Eine Nachkommastelle, wie im Preisvorschlag. */
function round(value: number): string {
  return (Math.round(value * 10) / 10).toLocaleString('de-DE');
}
