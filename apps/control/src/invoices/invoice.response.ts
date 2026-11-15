import type { Prisma, Invoice, InvoiceStatus, InvoiceLine, BuyerType } from '.prisma/control-client';
import { dateStringFromDate, today } from '@saas-instant/shared';
import { decimalAsCent } from './invoice.amount';

/**
 * Eine Rechnung, wie sie über die API geht.
 *
 * ALLE GELDBETRÄGE ALS ZEICHENKETTE, wie überall in diesem Projekt: Ein
 * `Decimal(10,2)` durch `number` zu schicken hieße Geldbeträge über Gleitkomma
 * zu reichen. Die Cent-Fassung geht zusätzlich mit, damit die Oberfläche
 * rechnen kann, ohne zu parsen.
 *
 * `pdfContent` und `xmlContent` gehen NIE mit — ein PDF gehört nicht in eine
 * JSON-Liste. Es gibt eine eigene Route dafür; hier steht nur, OB es vorliegt.
 */
export interface InvoiceLineResponse {
  id: string;
  label: string;
  /** Freitext unter der Bezeichnung. */
  description: string | null;
  /**
   * Mengeneinheit nach UN/ECE Rec. 20. Wurde gespeichert, aber bis zum
   * Redesign nicht ausgeliefert — das Formular konnte sie deshalb nicht
   * anzeigen, obwohl sie auf dem Beleg stand.
   */
  unit: string | null;
  /** Leistungszeitraum je Posten, beide oder keiner. */
  periodFrom: string | null;
  periodUntil: string | null;
  quantity: string;
  unitPriceNet: string;
  taxRate: string;
  netAmount: string;
  taxAmount: string;
  grossAmount: string;
  /** Steuerkategorie nach UNTDID 5305 (S, Z, E, AE, K, G, O). */
  taxCategory: string;
  taxExemptionReason: string | null;
  /** Preisstufe, aus der der Posten stammt (nur wenn aus dem Vorschlag übernommen). */
  priceTierKey: string | null;
  priceTierLabel: string | null;
}

/**
 * DER ABGELEITETE ZAHLUNGSSTAND.
 *
 * Der Auftrag verlangt „offen / überfällig / bezahlt / teilweise bezahlt /
 * storniert". Vier davon stehen als Spalte in der Datenbank, „überfällig"
 * ausdrücklich nicht — und das ist eine Entscheidung, keine Lücke:
 *
 * Überfälligkeit ist eine Aussage über den heutigen Tag, kein Ereignis. Wer
 * sie schriebe, bräuchte einen nächtlichen Lauf, der Rechnungen anfasst — ein
 * automatischer Schreibvorgang mit Geldfolge, und genau den schließt R5 aus.
 * Abgeleitet kann sie dagegen nicht veralten. Dieselbe Begründung wie bei den
 * Dashboard-Aufgaben, die nie gespeichert werden.
 */
export const PAYMENT_STATES = [
  'draft',
  'open',
  'overdue',
  // WIRD NICHT MEHR ERZEUGT (siehe `paymentStateFrom`). Der Wert bleibt im
  // Typ, damit eine alte gespeicherte Antwort oder ein alter Link nicht
  // plötzlich unbekannt ist — erzeugt wird er nirgends mehr.
  'partially_paid',
  'paid',
  'cancelled',
] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];

export interface InvoiceResponse {
  id: string;
  companyId: string;
  /**
   * Der HEUTIGE Name der Organisation — für Listen, nicht für den Beleg.
   *
   * Auf dem Beleg steht `recipientName`, wie er beim Festschreiben lautete;
   * der ändert sich nie (R2). Wer die Organisation heute sucht, sucht sie
   * unter ihrem heutigen Namen.
   */
  companyName: string | null;
  /** Einleitungssatz und Zahlungshinweis auf dem Beleg. */
  introduction: string | null;
  paymentNote: string | null;
  /** Der Zettel am Vorgang — nicht auf dem Beleg, nicht in einer Mail. */
  internalNote: string | null;
  invoiceNumber: string | null;
  status: InvoiceStatus;
  /** Abgeleitet aus Status, Fälligkeit und gezahltem Betrag. */
  paymentState: PaymentState;

  invoiceDate: string;
  servicePeriodFrom: string;
  servicePeriodUntil: string;
  dueDate: string;
  /** Technischer Zeitstempel (ISO), kein fachliches Datum. */
  finalizedAt: string | null;
  createdAt: string;

  paymentDate: string | null;
  paidAmount: string | null;
  openAmount: string;

  sumNet: string;
  sumTax: string;
  sumGross: string;
  sumGrossCent: number;

  /** Die Stornorechnung zu dieser Rechnung, falls es eine gibt. */
  cancellationInvoiceId: string | null;
  /** Die Rechnung, die diese hier storniert — falls sie eine Stornorechnung ist. */
  cancelledInvoiceId: string | null;
  cancellationReason: string | null;
  /** true = diese Rechnung IST eine Stornorechnung. */
  isCancellation: boolean;

  recipientName: string;
  recipientAddress: string;
  recipientEmail: string | null;

  transferStatus: string | null;
  /** Liegt das PDF/A-3b mit eingebettetem factur-x.xml vor? */
  documentPresent: boolean;
  /** Liegt die XRechnung (reines XML) vor? */
  xrechnungPresent: boolean;
  /** E-Rechnung: Art der Empfängerin und ihre Kennungen (Schnappschuss). */
  recipientBuyerType: BuyerType | null;
  recipientVatId: string | null;
  recipientBuyerReference: string | null;
  recipientElectronicAddress: string | null;
  recipientElectronicAddressScheme: string | null;
  currency: string;
  /** UNTDID 4461: 58 Überweisung, 59 Lastschrift. */
  paymentMeansCode: string;
  /** GoBD: Prüfsummen (SHA-256, hex) der einmal erzeugten Dokumente. */
  pdfSha256: string | null;
  xmlSha256: string | null;
  xrechnungSha256: string | null;
  /** Technischer Zeitstempel (ISO) der Dokumenterzeugung. */
  documentGeneratedAt: string | null;
  /** Ende der Aufbewahrungsfrist (Tagesdatum). */
  retentionUntil: string | null;

  lines: InvoiceLineResponse[];
}

/**
 * Die Rechnung OHNE die beiden Dokumentspalten.
 *
 * `pdfContent` ist rund 72 kB je Zeile. Würde die Liste sie mitladen, zöge eine
 * Jahresübersicht mit hundert Rechnungen sieben Megabyte durch den Prozess,
 * nur um daraus ein `true`/`false` zu machen. Deshalb bleiben beide Spalten
 * aus jeder Auswahl heraus, und `documentPresent` wird getrennt ermittelt —
 * über `pdfContent IS NOT NULL` in SQL, nicht über den Inhalt.
 */
export type InvoiceWithoutDocument = Omit<Invoice, 'pdfContent' | 'xmlContent' | 'xrechnungContent' | 'issuerLayout'> & {
  lines: InvoiceLine[];
  cancellationInvoice?: { id: string } | null;
  /** Optional, weil nicht jeder Leseweg die Organisation mitlädt. */
  company?: { name: string } | null;
};

function euro(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toFixed(2);
}

/**
 * Summe eines Postenfeldes in Cent.
 *
 * Exportiert, seit der Navigationszaehler dieselbe Summe braucht. Eine zweite
 * Fassung waere die Stelle, an der Zaehler und Rechnungsansicht eines Tages
 * verschiedene Betraege zeigen.
 */
type AmountField = 'netAmount' | 'taxAmount' | 'grossAmount';

export function sum<F extends AmountField>(
  // `Pick` statt des vollen Postens: Wer nur die Bruttobetraege braucht, soll
  // auch nur sie aus der Datenbank holen duerfen. Der volle Typ zwang sonst
  // jeden Aufrufer, zehn Spalten zu laden, um eine zu summieren.
  lines: readonly Pick<InvoiceLine, F>[],
  field: F,
): number {
  return lines.reduce((s, p) => s + (decimalAsCent(p[field]) ?? 0), 0);
}

function centAsEuroText(cent: number): string {
  const sign = cent < 0 ? '-' : '';
  const amount = Math.abs(cent);
  return `${sign}${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`;
}

/**
 * Der Zahlungsstand aus dem, was in der Datenbank steht.
 *
 * Reihenfolge der Prüfungen ist wesentlich: `storniert` sticht alles — eine
 * stornierte Rechnung ist nicht überfällig, egal wie alt sie ist. Sonst
 * meldete das Dashboard genau die Rechnungen an, die schon erledigt sind.
 */
export function paymentStateFrom(
  invoice: {
    status: InvoiceStatus;
    dueDate: Date;
    paidAmount: Prisma.Decimal | null;
  },
  sumGrossCent: number,
  todayDay: string = today(),
): PaymentState {
  if (invoice.status === 'cancelled') return 'cancelled';
  if (invoice.status === 'draft') return 'draft';

  const paid = decimalAsCent(invoice.paidAmount) ?? 0;
  // Vollständig bezahlt heißt: mindestens der Bruttobetrag ist eingegangen.
  // Bei einer Gutschrift (negative Summe) gilt sie als ausgeglichen, sobald
  // der Betrag erstattet wurde.
  if (sumGrossCent >= 0 ? paid >= sumGrossCent : paid <= sumGrossCent) {
    if (sumGrossCent !== 0 || paid !== 0) return 'paid';
  }
  // TEILWEISE BEZAHLT GIBT ES NICHT MEHR.
  //
  // Entscheidung des Auftraggebers beim Durchgang zum Redesign, woertlich:
  // „Ich muss Zahlungen ja manuell erfassen — es wird kein echtes Konto
  // gegengeprueft. Daher gibt es nur Offen oder Gezahlt. Wer weniger zahlt,
  // mit dem muss ich sowieso korrespondieren, aber das trage ich nicht ins
  // System ein."
  //
  // Der gezahlte Betrag WIRD WEITER FESTGEHALTEN — er gehoert zum Beleg und
  // steht in der Ansicht. Nur der ZUSTAND kennt kein Dazwischen mehr: Erst
  // wenn die Summe erreicht ist, springt er auf `bezahlt`; davor bleibt er
  // `offen` beziehungsweise `ueberfaellig`.
  //
  // Der Enumwert bleibt im Schema stehen und wird hier nicht mehr erzeugt —
  // wie `ueberfaellig`, das aus demselben Grund unbenutzt dasteht. Im
  // Bestand kam er nie vor, nachgezaehlt.

  return dateStringFromDate(invoice.dueDate) < todayDay
    ? 'overdue'
    : 'open';
}

export function toInvoiceResponse(
  invoice: InvoiceWithoutDocument,
  documentPresent: boolean,
  todayDay: string = today(),
  xrechnungPresent = false,
): InvoiceResponse {
  const sumNetCent = sum(invoice.lines, 'netAmount');
  const sumTaxCent = sum(invoice.lines, 'taxAmount');
  const sumGrossCent = sum(invoice.lines, 'grossAmount');
  const paidCent = decimalAsCent(invoice.paidAmount) ?? 0;

  return {
    id: invoice.id,
    companyId: invoice.companyId,
    companyName: invoice.company?.name ?? null,
    introduction: invoice.introduction,
    paymentNote: invoice.paymentNote,
    internalNote: invoice.internalNote,
    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status,
    paymentState: paymentStateFrom(invoice, sumGrossCent, todayDay),

    invoiceDate: dateStringFromDate(invoice.invoiceDate),
    servicePeriodFrom: dateStringFromDate(invoice.servicePeriodFrom),
    servicePeriodUntil: dateStringFromDate(invoice.servicePeriodUntil),
    dueDate: dateStringFromDate(invoice.dueDate),
    finalizedAt: invoice.finalizedAt?.toISOString() ?? null,
    createdAt: invoice.createdAt.toISOString(),

    paymentDate:
      invoice.paymentDate === null ? null : dateStringFromDate(invoice.paymentDate),
    paidAmount: euro(invoice.paidAmount),
    openAmount: centAsEuroText(sumGrossCent - paidCent),

    sumNet: centAsEuroText(sumNetCent),
    sumTax: centAsEuroText(sumTaxCent),
    sumGross: centAsEuroText(sumGrossCent),
    sumGrossCent,

    cancellationInvoiceId: invoice.cancellationInvoice?.id ?? null,
    cancelledInvoiceId: invoice.cancelledInvoiceId,
    cancellationReason: invoice.cancellationReason,
    isCancellation: invoice.cancelledInvoiceId !== null,

    recipientName: invoice.recipientName,
    recipientAddress: invoice.recipientAddress,
    recipientEmail: invoice.recipientEmail,

    transferStatus: invoice.transferStatus,
    documentPresent,
    xrechnungPresent,
    recipientBuyerType: invoice.recipientBuyerType,
    recipientVatId: invoice.recipientVatId,
    recipientBuyerReference: invoice.recipientBuyerReference,
    recipientElectronicAddress: invoice.recipientElectronicAddress,
    recipientElectronicAddressScheme: invoice.recipientElectronicAddressScheme,
    currency: invoice.currency,
    paymentMeansCode: invoice.paymentMeansCode,
    pdfSha256: invoice.pdfSha256,
    xmlSha256: invoice.xmlSha256,
    xrechnungSha256: invoice.xrechnungSha256,
    documentGeneratedAt: invoice.documentGeneratedAt?.toISOString() ?? null,
    retentionUntil:
      invoice.retentionUntil === null
        ? null
        : dateStringFromDate(invoice.retentionUntil),

    lines: invoice.lines.map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description,
      // WURDE GESPEICHERT, ABER NIE AUSGELIEFERT. Das Formular konnte die
      // Einheit deshalb nicht anzeigen, obwohl sie auf dem Beleg stand.
      unit: p.unit,
      periodFrom: p.periodFrom ? dateStringFromDate(p.periodFrom) : null,
      periodUntil: p.periodUntil ? dateStringFromDate(p.periodUntil) : null,
      quantity: p.quantity.toFixed(3),
      unitPriceNet: p.unitPriceNet.toFixed(2),
      taxRate: p.taxRate.toFixed(2),
      netAmount: p.netAmount.toFixed(2),
      taxAmount: p.taxAmount.toFixed(2),
      grossAmount: p.grossAmount.toFixed(2),
      taxCategory: p.taxCategory,
      taxExemptionReason: p.taxExemptionReason,
      priceTierKey: p.priceTierKey ?? null,
      priceTierLabel: p.priceTierLabel ?? null,
    })),
  };
}
