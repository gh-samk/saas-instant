import { datePlusDays, dateStringFromDate } from '@saas-instant/shared';
import { datePlusMonths, dayReadable } from '../../common/calendar';
import { TRIAL_DAYS } from '../../companies/deadlines';
import { urgencyFrom } from '../urgency';
import type {
  Task,
  TasksContext,
  TaskSource,
  SourceResult,
} from '../tasks.types';

/**
 * Zahlende Organisationen, bei denen ein Leistungszeitraum ABGELAUFEN ist,
 * ohne dass eine Rechnung ihn abdeckt.
 *
 * WARUM DIE REGEL SO UND NICHT ANDERS LAUTET. Das Datenmodell legt sich an
 * keiner Stelle darauf fest, ob im Voraus oder im Nachhinein abgerechnet wird:
 * `servicePeriodFrom`/`-Bis` werden von Hand eingetragen, es gibt keinen
 * Abrechnungslauf und keinen Turnus im Schema. Eine Aufgabe „im Voraus
 * fällig" müsste diesen Turnus erfinden.
 *
 * Deshalb schlägt diese Quelle erst an, wenn ein Zeitraum VORBEI ist und
 * niemand ihn berechnet hat. Das ist in beiden Abrechnungsweisen richtig: Wer
 * im Voraus abrechnet, hat die Rechnung längst geschrieben, und die Aufgabe
 * entsteht gar nicht erst. Wer im Nachhinein abrechnet, bekommt sie am Tag
 * nach Ablauf. Falsch liegen kann sie nur in eine Richtung — sie meldet
 * später als nötig, nie früher als berechtigt.
 *
 * SIE LEGT KEINE RECHNUNG AN (R5). Es gibt in dieser Datei keinen
 * Schreibvorgang. Zeitraum, Posten und Beträge entscheidet die Betreiberin im
 * Entwurfsformular — die Aufgabe führt sie nur dorthin.
 *
 * OHNE PREISVEREINBARUNG KEINE AUFGABE: Dafür gibt es `preisangabe_fehlt`.
 * Zwei Aufgaben für dieselbe Lücke wären zwei Zeilen für eine Handlung.
 */
export const invoiceDue: TaskSource = {
  kind: 'invoice_due',

  async collect(context: TasksContext): Promise<SourceResult> {
    const candidates = await context.prisma.company.findMany({
      where: {
        status: 'paying',
        paymentInterval: { not: null },
        instanceStartDate: { not: null },
        OR: [
          { priceTier: { not: null } },
          { customAmount: { not: null } },
        ],
      },
      select: {
        id: true,
        name: true,
        status: true,
        paymentInterval: true,
        instanceStartDate: true,
        invoices: {
          select: {
            status: true,
            servicePeriodUntil: true,
            cancelledInvoiceId: true,
          },
        },
      },
    });
    // Der Name ist verschluesselt: im Speicher sortieren.
    candidates.sort((a, b) => a.name.localeCompare(b.name, 'de'));

    const due = candidates.flatMap((row) => {
      if (row.instanceStartDate === null || row.paymentInterval === null) {
        return [];
      }

      // Der erste Tag, ab dem das Abo überhaupt berechenbar ist. Die
      // Einrichtung ist davon unberührt — sie ist mit dem Aufsetzen der
      // Instanz erbracht und wird nicht über diese Aufgabe erinnert.
      const aboFrom = datePlusDays(
        dateStringFromDate(row.instanceStartDate),
        TRIAL_DAYS,
      );

      // WAS ALS ABGEDECKT ZÄHLT: nur festgeschriebene Belege, die selbst keine
      // Stornorechnung sind. Ein Entwurf deckt nichts ab — er kann noch
      // geändert oder verworfen werden. Eine stornierte Rechnung deckt
      // ebenfalls nichts ab, sonst verschwände der Zeitraum mit dem Storno
      // lautlos aus der Abrechnung.
      const covering = row.invoices.filter(
        (r) =>
          r.cancelledInvoiceId === null &&
          r.status !== 'draft' &&
          r.status !== 'cancelled',
      );
      const coveredUntil = covering.reduce<string | null>((soFar, r) => {
        const day = dateStringFromDate(r.servicePeriodUntil);
        return soFar === null || day > soFar ? day : soFar;
      }, null);

      const periodsStart =
        coveredUntil === null ? aboFrom : datePlusDays(coveredUntil, 1);
      // [H3] Halbjährlich ist ein eigener Rhythmus (6 Monate); mit dem früheren
      // „monatlich sonst 12" wurde der Zeitraum einer halbjährlich zahlenden
      // Organisation erst nach einem Jahr als abgelaufen gemeldet.
      const months =
        row.paymentInterval === 'monthly'
          ? 1
          : row.paymentInterval === 'half_yearly'
            ? 6
            : 12;
      const periodsEnd = datePlusDays(
        datePlusMonths(periodsStart, months),
        -1,
      );

      // Noch nicht abgelaufen — also nichts zu tun. Das ist der Normalfall.
      if (periodsEnd >= context.todayDay) return [];

      const dueAt = datePlusDays(periodsEnd, 1);
      const draftOpen = row.invoices.some((r) => r.status === 'draft');

      return [
        {
          kind: 'invoice_due' as const,
          dueAt,
          urgency: urgencyFrom(dueAt, context.todayDay),
          title: `Rechnung für ${row.name} erstellen`,
          reason:
            `Der Leistungszeitraum ${dayReadable(periodsStart)} bis ` +
            `${dayReadable(periodsEnd)} ist abgelaufen, und keine ` +
            'festgeschriebene Rechnung deckt ihn ab. ' +
            (draftOpen
              ? 'Ein Entwurf liegt bereits vor — abdecken wird der Zeitraum ' +
                'erst mit dem Festschreiben. '
              : '') +
            'Angelegt wird hier nichts (R5): Zeitraum, Posten und Beträge ' +
            'entscheidest du im Entwurf.',
          action: {
            kind: 'invoice_create' as const,
            label: 'Rechnung anlegen',
            target: `/companies/${row.id}`,
          },
          company: { id: row.id, name: row.name, status: row.status },
        },
      ];
    });

    // Liegen mehrere Zeiträume offen, entsteht eine Aufgabe für den ÄLTESTEN.
    // Sie verschwindet, sobald er berechnet ist, und der nächste rückt nach —
    // in der Reihenfolge, in der auch die Rechnungsnummern entstehen.
    return {
      total: due.length,
      tasks: due.slice(0, context.limit) as Task[],
    };
  },
};
