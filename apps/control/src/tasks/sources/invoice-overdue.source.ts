import type { InvoiceStatus } from '.prisma/control-client';
import { dateStringFromDate, toDate } from '@saas-instant/shared';
import { decimalAsCent } from '../../invoices/invoice.amount';
import { urgencyFrom } from '../urgency';
import type {
  TasksContext,
  TaskSource,
  SourceResult,
} from '../tasks.types';

/**
 * Rechnungen, deren Fälligkeit vorbei ist und für die keine vollständige
 * Zahlung vermerkt wurde.
 *
 * WARUM ÜBERFÄLLIGKEIT EINE AUFGABE IST UND KEIN STATUS:
 * Der Enum `InvoiceStatus` kennt seit der Init-Migration einen Wert
 * `ueberfaellig`. Er bleibt ausdrücklich unbenutzt. Ihn zu setzen bräuchte
 * einen nächtlichen Lauf, der Rechnungen anfasst — einen automatischen
 * Schreibvorgang mit Geldfolge, und genau den schließt R5 aus. Dieselbe
 * Begründung, aus der `pilot_running → zahlend` nur deshalb automatisch laufen
 * darf, WEIL dieser Wechsel keine Geldfolge hat.
 *
 * Abgeleitet kann die Aussage außerdem nicht veralten: Wird eine Zahlung
 * vermerkt, verschwindet die Aufgabe im selben Augenblick. Ein geschriebener
 * Status müsste zurückgesetzt werden, und der Lauf, der das tut, wäre der
 * nächste automatische Schreibvorgang.
 *
 * STORNIERTE RECHNUNGEN SIND NIE ÜBERFÄLLIG, auch wenn ihr Fälligkeitsdatum
 * Jahre zurückliegt: Sie sind aufgehoben. Entwürfe ebenso — sie waren nie
 * draußen.
 */
/**
 * Die drei Zustaende, in denen noch Geld erwartet wird.
 *
 * `bezahlt`, `storniert` und `draft` stehen bewusst nicht dabei: Eine
 * stornierte Rechnung ist aufgehoben, ein Entwurf war nie draussen.
 */
const OPEN_STATES: InvoiceStatus[] = [
  'finalized',
  'sent',
  'partially_paid',
];

export const invoiceOverdue: TaskSource = {
  kind: 'invoice_overdue',

  async collect(context: TasksContext): Promise<SourceResult> {
    const where = {
      dueDate: { lt: toDate(context.todayDay) },
      status: { in: OPEN_STATES },
    };

    const [rows, total] = await Promise.all([
      context.prisma.invoice.findMany({
        where,
        select: {
          id: true,
          invoiceNumber: true,
          dueDate: true,
          company: { select: { id: true, name: true, status: true } },
          lines: { select: { grossAmount: true } },
          paidAmount: true,
        },
        orderBy: { dueDate: 'asc' },
        take: context.limit,
      }),
      context.prisma.invoice.count({ where }),
    ]);

    return {
      total,
      tasks: rows.map((row) => {
        const dueAt = dateStringFromDate(row.dueDate);
        // Cent-Rechnung wie im ganzen Modul: Ein `Decimal` über `number` zu
        // summieren hieße Geldbeträge über Gleitkomma reichen.
        const grossCent = row.lines.reduce(
          (sum, lines) => sum + (decimalAsCent(lines.grossAmount) ?? 0),
          0,
        );
        const openCent = grossCent - (decimalAsCent(row.paidAmount) ?? 0);
        const open = (openCent / 100).toLocaleString('de-DE', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        // Ganze Tage seit der Fälligkeit; überfällig ist sie mindestens seit
        // gestern, also nie unter einem Tag.
        const days = Math.max(
          1,
          Math.round(
            (Date.parse(`${context.todayDay}T00:00:00.000Z`) -
              Date.parse(`${dueAt}T00:00:00.000Z`)) /
              86_400_000,
          ),
        );
        return {
          kind: 'invoice_overdue' as const,
          dueAt,
          urgency: urgencyFrom(dueAt, context.todayDay),
          invoiceId: row.id,
          // KURZ, WEIL DIE ZEILE ES SO ZEIGT: Titel „Rechnung N überfällig ·
          // Betrag", darunter Organisation und Alter. Der Name der
          // Organisation steht im Feld `company` und wird nicht noch einmal
          // in den Titel geschrieben. Der immer gleiche Erklärsatz („Der
          // Zahlungseingang wird von Hand vermerkt …") steht einmal als
          // Hinweis über der Gruppe in der Oberfläche, nicht in jeder Zeile.
          title: `Rechnung ${row.invoiceNumber ?? ''} überfällig · ${open} €`,
          reason: `seit ${days} ${days === 1 ? 'Tag' : 'Tagen'}`,
          action: {
            kind: 'payment_check' as const,
            label: 'Rechnung öffnen',
            target: `/companies/${row.company.id}/invoices/${row.id}`,
          },
          company: {
            id: row.company.id,
            name: row.company.name,
            status: row.company.status,
          },
        };
      }),
    };
  },
};
