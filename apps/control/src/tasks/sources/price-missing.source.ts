import { datePlusDays, dateStringFromDate, toDate } from '@saas-instant/shared';
import { PILOT_TO_PAYING_AFTER_DAYS } from '../../companies/deadlines';
import { urgencyFrom } from '../urgency';
import type {
  TasksContext,
  TaskSource,
  SourceResult,
} from '../tasks.types';

/**
 * Piloten, die auf „zahlend" wechseln müssten — bei denen aber keine
 * Preisvereinbarung hinterlegt ist ([H1]).
 *
 * WARUM DAS EINE AUFGABE IST UND KEIN AUTOMATISCHER WECHSEL:
 * Der Zeitplan darf `pilot_running → zahlend` nur vollziehen, weil dieser
 * Wechsel OHNE GELDFOLGE ist — das ist die Bedingung, unter der R5 ihn
 * überhaupt erlaubt. Ohne Preisstufe und ohne abweichenden Betrag wäre
 * `paying` aber genau die Behauptung, für die es keine Grundlage gibt: In
 * Etappe 4 setzen die Rechnungen auf diesem Status auf. Der Zeitplan übergeht
 * solche Organisationen deshalb, und stattdessen entsteht hier eine Aufgabe.
 *
 * So bleibt R5 auch nach Etappe 4 eine Eigenschaft und nicht bloß eine
 * Zusicherung, die durch das Hinzufügen der Rechnungen still verfällt.
 */
export const priceInfoMissing: TaskSource = {
  kind: 'price_info_missing',

  async collect(context: TasksContext): Promise<SourceResult> {
    const startLimit = datePlusDays(
      context.todayDay,
      -PILOT_TO_PAYING_AFTER_DAYS,
    );
    const where = {
      status: 'pilot_running' as const,
      instanceStartDate: { not: null, lte: toDate(startLimit) },
      priceTier: null,
      customAmount: null,
    };

    const [rows, total] = await Promise.all([
      context.prisma.company.findMany({
        where,
        select: { id: true, name: true, status: true, instanceStartDate: true },
        orderBy: { instanceStartDate: 'asc' },
        take: context.limit,
      }),
      context.prisma.company.count({ where }),
    ]);

    return {
      total,
      tasks: rows.flatMap((row) => {
        if (row.instanceStartDate === null) return [];
        const dueAt = datePlusDays(
          dateStringFromDate(row.instanceStartDate),
          PILOT_TO_PAYING_AFTER_DAYS,
        );
        return [
          {
            kind: 'price_info_missing' as const,
            dueAt,
            urgency: urgencyFrom(dueAt, context.todayDay),
            title: `Preis mit ${row.name} vereinbaren`,
            reason:
              `Die Pilotphase läuft seit mehr als ` +
              `${PILOT_TO_PAYING_AFTER_DAYS} Tagen, aber es ist weder eine ` +
              'Preisstufe noch ein abweichender Betrag hinterlegt. Der ' +
              'Wechsel auf „Zahlend" findet deshalb NICHT von allein statt — ' +
              'er wird vorgeschlagen, nicht vollzogen (R5).',
            action: {
              kind: 'price_agree' as const,
              label: 'Preis hinterlegen',
              target: `/companies/${row.id}`,
            },
            company: { id: row.id, name: row.name, status: row.status },
          },
        ];
      }),
    };
  },
};
