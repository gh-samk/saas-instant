import { Prisma } from '.prisma/control-client';
import { today } from '@saas-instant/shared';
import type { DbClient } from '../prisma/db-client';
import type { PrismaService } from '../prisma/prisma.service';
import { InvoiceNotFoundError } from './invoice.errors';
import {
  toInvoiceResponse,
  type InvoiceResponse,
  type InvoiceWithoutDocument,
} from './invoice.response';

/**
 * DIE LESEWEGE EINER RECHNUNG — an EINER Stelle.
 *
 * Drei Dienste brauchen dieselbe Antwort (`InvoiceService`, `PaymentService`,
 * `InvoiceSendService`), und alle drei dürfen dabei dieselbe Falle nicht
 * tappen: `pdfContent` mitzuladen. Die Spalte ist rund 72 kB je Zeile; eine
 * Jahresübersicht zöge damit sieben Megabyte durch den Prozess, nur um daraus
 * ein `true`/`false` zu machen.
 *
 * Deshalb steht die Feldliste hier und ist ausdrücklich aufgezählt. Wer eine
 * Spalte ergänzt, muss sie eintragen — und stolpert dabei über die Frage, ob
 * sie in eine Liste gehört.
 */

/** Kopfdaten ohne Posten, ohne Dokumentspalten. */
export const HEADER_FIELDS = {
  id: true,
  companyId: true,
  invoiceNumber: true,
  invoiceDate: true,
  servicePeriodFrom: true,
  servicePeriodUntil: true,
  dueDate: true,
  dueDateManual: true,
  status: true,
  paymentDate: true,
  paidAmount: true,
  finalizedAt: true,
  cancelledInvoiceId: true,
  cancellationReason: true,
  pdfPath: true,
  xmlPath: true,
  transferStatus: true,
  recipientName: true,
  recipientAddress: true,
  recipientEmail: true,
  issuerCompanyName: true,
  issuerAddress: true,
  issuerVatId: true,
  issuerSeat: true,
  issuerRegisterCourt: true,
  issuerCommercialRegisterA: true,
  issuerGeneralPartner: true,
  issuerGeneralPartnerSeat: true,
  issuerGeneralPartnerRegisterCourt: true,
  issuerGeneralPartnerCommercialRegisterB: true,
  issuerManagingDirector: true,
  issuerBankDetails: true,
  recipientBuyerType: true,
  recipientVatId: true,
  recipientBuyerReference: true,
  recipientElectronicAddress: true,
  recipientElectronicAddressScheme: true,
  issuerContactName: true,
  issuerContactPhone: true,
  issuerContactEmail: true,
  issuerIban: true,
  issuerBic: true,
  issuerBankName: true,
  currency: true,
  paymentMeansCode: true,
  // Integrität und Aufbewahrung (GoBD): nur Prüfsummen und Fristen, nie die
  // Dokumentbytes selbst.
  pdfSha256: true,
  xmlSha256: true,
  xrechnungSha256: true,
  documentGeneratedAt: true,
  retentionUntil: true,
  // Der Schnappschuss der Mandatsreferenz. Steht sie da, wird eingezogen —
  // und auf dem Beleg steht die Vorabankündigung statt der gewöhnlichen
  // Zahlungsbedingung.
  directDebitMandateReference: true,
  // Die drei Texte des Bearbeiten-Screens. `internalNote` steht NICHT auf dem
  // Beleg und geht in keine Mail — sie wird trotzdem mitgelesen, weil das
  // Formular sie zeigt.
  introduction: true,
  paymentNote: true,
  internalNote: true,
  createdAt: true,
} satisfies Prisma.InvoiceSelect;

/**
 * Reihenfolge der Posten (M11): erst nach gespeicherter Position, Altposten
 * ohne Position (NULL) zuletzt und untereinander wie bisher nach Id. Die Id
 * ist eine UUIDv4 und gibt keine Eingabereihenfolge her; Posten festgeschriebener
 * Rechnungen lassen sich per GoBD-Trigger nicht nachtragen.
 */
export const LINE_ORDER = [
  { position: { sort: 'asc', nulls: 'last' } },
  { id: 'asc' },
] satisfies Prisma.InvoiceLineOrderByWithRelationInput[];

/** Kopf plus Posten plus Rückverweis auf die Stornorechnung. */
export const RESPONSE_FIELDS = {
  ...HEADER_FIELDS,
  lines: { orderBy: LINE_ORDER },
  cancellationInvoice: { select: { id: true } },
  /**
   * Der NAME der Organisation, nicht nur ihre Kennung.
   *
   * Seit der globalen Rechnungsliste: Dort steht je Zeile eine andere
   * Organisation, und eine Kennung sagt niemandem etwas. Ihn im Frontend
   * nachzuladen hiesse eine Abfrage je Zeile.
   *
   * ES IST DER HEUTIGE NAME, nicht der aus dem Schnappschuss. Auf dem BELEG
   * steht `recipientName`, wie er beim Festschreiben lautete — der aendert
   * sich nie (R2). Diese Spalte ist die Liste, nicht der Beleg: Wer die
   * Organisation heute sucht, sucht sie unter ihrem heutigen Namen.
   */
  company: { select: { name: true } },
} satisfies Prisma.InvoiceSelect;

/**
 * Ergänzt `documentPresent`, OHNE die Dokumente zu laden.
 *
 * Eine eigene Abfrage mit `pdfContent IS NOT NULL` statt `select: { pdfInhalt:
 * true }`: Prisma kann ein `Bytes`-Feld nicht auf „ist gesetzt" verkürzen, es
 * holte den ganzen Inhalt.
 */
export async function withDocumentMarker(
  prisma: PrismaService,
  rows: InvoiceWithoutDocument[],
): Promise<InvoiceResponse[]> {
  if (rows.length === 0) return [];
  const withDocument = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Invoice"
    WHERE "id" IN (${Prisma.join(rows.map((z) => z.id))})
      AND "pdfContent" IS NOT NULL`;
  const present = new Set(withDocument.map((z) => z.id));
  const withXr = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Invoice"
    WHERE "id" IN (${Prisma.join(rows.map((z) => z.id))})
      AND "xrechnungContent" IS NOT NULL`;
  const presentXr = new Set(withXr.map((z) => z.id));
  const day = today();
  return rows.map((row) =>
    toInvoiceResponse(row, present.has(row.id), day, presentXr.has(row.id)),
  );
}

/** Eine einzelne Rechnung als Antwort. */
export async function getInvoice(
  prisma: PrismaService,
  id: string,
): Promise<InvoiceResponse> {
  const row = await prisma.invoice.findUnique({
    where: { id },
    select: RESPONSE_FIELDS,
  });
  if (!row) throw new InvoiceNotFoundError();
  const [response] = await withDocumentMarker(prisma, [row]);
  // Kann nicht leer sein — eine Zeile hinein, eine Zeile heraus.
  return response as InvoiceResponse;
}

/** Sperrt eine Rechnungszeile für die Dauer der Transaktion. */
export async function lockInvoice(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${id} FOR UPDATE`;
}

/** Nur damit `DbClient` als Typ referenziert bleibt, wo Dienste ihn erwarten. */
export type InvoiceDbClient = DbClient;
