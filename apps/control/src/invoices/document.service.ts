import { Inject, Injectable, Logger } from '@nestjs/common';
import { dateStringFromDate } from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import type { InquirySource } from '../common/inquiry-source';
import { PrismaService } from '../prisma/prisma.service';
import { IssuerConfigService } from './document/issuer.config';
import { createCii } from './document/cii-en16931';
import { createHtml, dateAsText } from './document/layout-html';
import type {
  DocumentLine,
  DocumentTaxShare,
  InvoiceDocument,
} from './document/document.types';
import {
  INVOICE_RENDERER,
  type InvoiceRenderer,
} from './document/invoice-renderer.client';
import { decimalAsCent } from './invoice.amount';
import {
  InvoiceNotFoundError,
  InvoiceStatusMismatchError,
  InvoiceDocumentInvalidError,
} from './invoice.errors';
import type { Actor } from './invoice.service';
import { CreditorIdMissingError } from './invoice.errors';

/**
 * DAS DOKUMENT ZU EINER FESTGESCHRIEBENEN RECHNUNG.
 *
 * ===========================================================================
 * WARUM DAS NICHT IM FESTSCHREIBEN STECKT
 * ===========================================================================
 *
 * Das Festschreiben hält eine Beratungssperre auf dem gesamten Nummernkreis
 * des Jahres. Ein HTTP-Aufruf in dieser Transaktion hieße: Solange der
 * Rechnungsdienst rendert, kann niemand sonst eine Rechnung festschreiben —
 * und ein Zeitablauf mitten in der Transaktion machte aus einem Netzproblem
 * eine verlorene Rechnung.
 *
 * Deshalb zwei Schritte. Die Folge ist eine Rechnung, die festgeschrieben ist
 * und (noch) kein Dokument hat. Das ist der bessere Zustand von beiden: Die
 * Nummer ist vergeben, es entsteht KEINE LÜCKE, und das Dokument lässt sich
 * jederzeit nachziehen — es entsteht ausschließlich aus dem Schnappschuss und
 * ist deshalb beim zweiten Anlauf dasselbe.
 *
 * ===========================================================================
 * WAS BEI EINEM UNGÜLTIGEN DOKUMENT GESCHIEHT
 * ===========================================================================
 *
 * Der Rechnungsdienst prüft jedes erzeugte PDF selbst nach und antwortet bei
 * einem Mangel mit 422 statt mit einem ungültigen PDF. Diese Entscheidung wird
 * hier nicht aufgeweicht: Es wird nichts gespeichert, der Vorgang steht im
 * Audit-Log, und die Antwort trägt den Prüfbericht. Ein ungültiger Beleg wäre
 * schlimmer als keiner — er sähe aus wie einer.
 */
/**
 * Der Wortlaut der Vorabankündigung.
 *
 * WIRFT OHNE GLÄUBIGER-ID, und zwar mit Absicht — dieselbe Bauart wie
 * `laendercode()`. Die drei Alternativen wären alle schlechter:
 *
 * - Die Ankündigung weglassen hiesse, neben einem laufenden Einzug „Zahlbar
 *   ohne Abzug bis zum …" zu drucken. Das führt zur Doppelzahlung.
 * - Sie ohne Gläubiger-ID drucken hiesse, eine Ankündigung auszustellen, die
 *   die Kundin bei ihrer Bank zu nichts gebrauchen kann.
 * - Eine Kennung erfinden ist der Fehler, den [W2] schon einmal gemacht hat.
 *
 * Der Fehler nennt die Variable, die fehlt. Ohne ihn stünde in der Meldung
 * nur „Dokument konnte nicht erzeugt werden".
 */
export function preNotification(
  dueAt: string,
  mandateReference: string,
  creditorId: string,
): string {
  if (creditorId.trim() === '') {
    throw new CreditorIdMissingError();
  }
  return (
    `Der Betrag wird am ${dateAsText(dueAt)} per SEPA-Lastschrift von ` +
    'Ihrem Konto eingezogen — bitte nicht überweisen. ' +
    `Mandatsreferenz ${mandateReference}, ` +
    `Gläubiger-Identifikationsnummer ${creditorId.trim()}.`
  );
}

@Injectable()
export class InvoiceDocumentService {
  private readonly logger = new Logger(InvoiceDocumentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly issuer: IssuerConfigService,
    @Inject(INVOICE_RENDERER) private readonly renderer: InvoiceRenderer,
  ) {}

  /**
   * Liefert das PDF — erzeugt es beim ersten Mal.
   *
   * IDEMPOTENT: Liegt bereits eines vor, wird es zurückgegeben und nicht neu
   * erzeugt. Ein zweiter Aufruf darf den Beleg nicht ersetzen; zwei
   * Ausfertigungen derselben Rechnungsnummer, die sich unterscheiden, wären
   * genau die Sorte Widerspruch, die eine Betriebsprüfung findet.
   */
  async getOrCreate(
    id: string,
    actor: Actor,
    source: InquirySource,
  ): Promise<{ pdf: Buffer; filename: string }> {
    const present = await this.prisma.invoice.findUnique({
      where: { id },
      select: { pdfContent: true, invoiceNumber: true, status: true },
    });
    if (!present) throw new InvoiceNotFoundError();
    if (present.status === 'draft') {
      // Ein Entwurf hat keine Nummer. Ein PDF ohne Rechnungsnummer wäre kein
      // Beleg, sähe aber aus wie einer — und läge dann in einem Postfach.
      throw new InvoiceStatusMismatchError('draft', 'finalized');
    }
    if (present.pdfContent !== null) {
      return {
        pdf: Buffer.from(present.pdfContent),
        filename: this.filename(present.invoiceNumber),
      };
    }
    return this.create(id, actor, source);
  }

  /** Erzeugt das Dokument und legt es an der Rechnung ab. */
  async create(
    id: string,
    actor: Actor,
    source: InquirySource,
  ): Promise<{ pdf: Buffer; filename: string }> {
    const document = await this.buildDocument(id);
    const html = createHtml(document);
    const xml = createCii(document);

    let pdf: Buffer;
    try {
      pdf = await this.renderer.create(html, xml);
    } catch (exception) {
      if (exception instanceof InvoiceDocumentInvalidError) {
        await this.audit.log({
          userId: actor.userId,
          actor: actor.name,
          action: AUDIT_ACTION.invoiceDocumentInvalid,
          objectType: 'Invoice',
          objectId: id,
          afterValue: { invoiceNumber: document.number },
          ...source,
        });
      }
      throw exception;
    }

    // ===================================================================
    // [W2] BEDINGT SCHREIBEN — und wer verliert, gibt das GESPEICHERTE aus
    // ===================================================================
    //
    // „Erzeugt es beim ersten Aufruf und gibt danach immer dasselbe heraus"
    // war ein check-then-act ohne Sperre. Gemessen mit fünf gleichzeitigen
    // `GET /invoices/:id/dokument`: vier verschiedene Bytefolgen
    // herausgegeben, eine gespeichert. Ein Doppelklick während des Versands,
    // und die Kundin hält eine andere Ausfertigung als das Archiv — genau der
    // „Widerspruch, den eine Betriebsprüfung findet".
    //
    // WARUM KEINE SPERRE ÜBER DEN GANZEN VORGANG: Zwischen Prüfung und
    // Speichern liegt ein HTTP-Aufruf an den Rechnungsdienst. Eine
    // Datenbanktransaktion darüber offen zu halten hielte eine Verbindung
    // über Sekunden.
    //
    // STATTDESSEN EIN BEDINGTER SCHREIBVORGANG: `updateMany` trifft nur, wenn
    // die Spalte noch leer ist. Wer das Rennen verliert, bekommt `count: 0` —
    // und liest dann die GESPEICHERTE Fassung und gibt DIESE aus. Sein eigenes
    // PDF wird verworfen. Damit gilt die Invariante, auf die es ankommt:
    // *Was ausgegeben wird, ist immer das, was im Archiv liegt.*
    const { count } = await this.prisma.invoice.updateMany({
      // NUR DIE BEIDEN DOKUMENTSPALTEN. Kein Betrag, kein Datum, kein Status —
      // diese Methode ist kein Änderungsbefehl für eine Rechnung (R2).
      where: { id, pdfContent: null },
      data: { pdfContent: pdf, xmlContent: Buffer.from(xml, 'utf8') },
    });

    if (count === 0) {
      // Ein anderer Aufruf war schneller. Seine Fassung ist die verbindliche.
      const stored = await this.prisma.invoice.findUnique({
        where: { id },
        select: { pdfContent: true, invoiceNumber: true },
      });
      if (stored?.pdfContent) {
        this.logger.log(
          `Rechnungsdokument ${document.number} war bereits abgelegt; die ` +
            'gespeicherte Fassung wird ausgegeben.',
        );
        return {
          pdf: Buffer.from(stored.pdfContent),
          filename: this.filename(stored.invoiceNumber),
        };
      }
      // Weder geschrieben noch vorhanden: Die Rechnung ist inzwischen weg.
      throw new InvoiceNotFoundError();
    }

    await this.audit.log({
      userId: actor.userId,
      actor: actor.name,
      action: AUDIT_ACTION.invoiceDocumentGenerated,
      objectType: 'Invoice',
      objectId: id,
      afterValue: {
        invoiceNumber: document.number,
        sizeBytes: pdf.byteLength,
      },
      ...source,
    });

    this.logger.log(
      `Rechnungsdokument ${document.number} erzeugt (${pdf.byteLength} Bytes).`,
    );
    return { pdf, filename: this.filename(document.number) };
  }

  /** Das eingebettete XML einzeln — für die Übergabe an die Buchhaltung. */
  async getXml(id: string): Promise<{ xml: Buffer; filename: string }> {
    const row = await this.prisma.invoice.findUnique({
      where: { id },
      select: { xmlContent: true, invoiceNumber: true },
    });
    if (!row) throw new InvoiceNotFoundError();
    if (row.xmlContent === null) {
      throw new InvoiceStatusMismatchError('without_document', 'with_document');
    }
    return {
      xml: Buffer.from(row.xmlContent),
      filename: `${(row.invoiceNumber ?? 'rechnung').replace(/[^\w-]/g, '')}.xml`,
    };
  }

  private filename(invoiceNumber: string | null): string {
    const core = (invoiceNumber ?? 'rechnung').replace(/[^\w-]/g, '');
    return `Rechnung-${core}.pdf`;
  }

  /**
   * Baut das Dokumentmodell — AUSSCHLIESSLICH aus dem Schnappschuss.
   *
   * Es wird keine einzige Angabe über die Relation zur Organisation gelesen.
   * Das ist R2 an der Stelle, an der es zählt: Der Beleg von 2026 sieht 2031
   * genauso aus wie am Tag seiner Ausstellung, auch wenn die Kundin
   * zwischenzeitlich umgezogen ist oder ihre Kontaktdaten gelöscht wurden.
   *
   * Zwei Angaben kommen aus der KONFIGURATION statt aus dem Schnappschuss, und
   * das ist Absicht: Telefonnummer und E-Mail der Rechnungsstelle. Sie sind
   * keine Aussage über den Geschäftsvorfall, sondern der Weg für Rückfragen —
   * eine alte Nummer im Nachdruck einer alten Rechnung hülfe niemandem.
   */
  private async buildDocument(id: string): Promise<InvoiceDocument> {
    const r = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        lines: { orderBy: { id: 'asc' } },
        cancelledInvoice: { select: { invoiceNumber: true } },
      },
    });
    if (!r) throw new InvoiceNotFoundError();
    if (r.invoiceNumber === null) {
      throw new InvoiceStatusMismatchError(r.status, 'finalized');
    }

    const coolifyConfig = this.issuer.read();
    const [street = '', postalCodeCity = '', country = 'DE'] =
      r.recipientAddress.split('\n');
    const separation = /^(\S+)\s+(.*)$/.exec(postalCodeCity.trim());

    const lines: DocumentLine[] = r.lines.map((p, index) => ({
      row: String(index + 1),
      label: p.label,
      // Beide Angaben wurden geschrieben und beim Rendern wieder fallen
      // gelassen — die Betreiberin tippte einen Text, der auf keinem Beleg
      // ankam. Die Renderer konnten sie die ganze Zeit.
      ...(p.description ? { description: p.description } : {}),
      ...(p.periodFrom && p.periodUntil
        ? {
            period: {
              from: dateStringFromDate(p.periodFrom),
              until: dateStringFromDate(p.periodUntil),
            },
          }
        : {}),
      quantity: Number(p.quantity.toFixed(3)),
      // [H2]: Die gespeicherte Einheit, nicht mehr fest `C62`. Ein Posten von
      // vor dieser Änderung hat keine — dann bleibt es bei `C62` (Stück), also
      // bei genau der Ausgabe, die er damals bekommen hat.
      unit: p.unit ?? 'C62',
      unitPriceCent: decimalAsCent(p.unitPriceNet) ?? 0,
      netCent: decimalAsCent(p.netAmount) ?? 0,
      taxCategory: 'S',
      taxRate: Number(p.taxRate.toFixed(2)),
    }));

    // Die Steueraufteilung wird aus den GESPEICHERTEN Postenbeträgen neu
    // gebildet, nicht neu gerechnet: Was im Beleg steht, ist maßgeblich.
    const byRecord = new Map<number, DocumentTaxShare>();
    r.lines.forEach((p) => {
      const record = Number(p.taxRate.toFixed(2));
      const entry = byRecord.get(record) ?? {
        category: 'S',
        record,
        basisCent: 0,
        taxCent: 0,
      };
      entry.basisCent += decimalAsCent(p.netAmount) ?? 0;
      entry.taxCent += decimalAsCent(p.taxAmount) ?? 0;
      byRecord.set(record, entry);
    });
    const taxBreakdown = [...byRecord.values()];

    const sumNetCent = lines.reduce((s, p) => s + p.netCent, 0);
    const sumTaxCent = taxBreakdown.reduce((s, t) => s + t.taxCent, 0);
    const sumGrossCent = sumNetCent + sumTaxCent;

    const dueAt = dateStringFromDate(r.dueDate);
    const isCancellation = r.cancelledInvoiceId !== null;

    return {
      number: r.invoiceNumber,
      invoiceDate: dateStringFromDate(r.invoiceDate),
      dueAt,
      currency: 'EUR',
      servicePeriod: {
        from: dateStringFromDate(r.servicePeriodFrom),
        until: dateStringFromDate(r.servicePeriodUntil),
      },
      deliveryDate: dateStringFromDate(r.servicePeriodFrom),
      orderReference: r.invoiceNumber,
      issuer: {
        // SCHNAPPSCHUSS, wo er vorliegt — Firmierung, Anschrift, Register.
        name: r.issuerCompanyName,
        address: (() => {
          const [aStreet = '', aPostalCodeCity = '', aCountry = 'DE'] =
            r.issuerAddress.split('\n');
          const aSeparation = /^(\S+)\s+(.*)$/.exec(aPostalCodeCity.trim());
          return {
            street: aStreet.trim(),
            postalCode: aSeparation?.[1] ?? '',
            city: aSeparation?.[2] ?? aPostalCodeCity.trim(),
            country: aCountry.trim() || 'DE',
          };
        })(),
        // [W3]: Der SITZ kommt aus dem Schnappschuss und NICHT aus der
        // laufenden Konfiguration. Eine Rechnung von 2026, die 2031 neu
        // gerendert wird, muss den Sitz von 2026 nennen — sonst wäre der
        // Beleg nachträglich verändert (R2). Ist er leer, war die Rechnung
        // vor [W3] festgeschrieben; dann bleibt die Angabe leer, statt eine
        // zu erfinden.
        seat: r.issuerSeat ?? '',
        vatId: r.issuerVatId ?? '',
        // AUS DER LAUFENDEN KONFIGURATION, nicht aus dem Schnappschuss: Die
        // Gläubiger-ID des Hauses ändert sich nicht mit der Rechnung, und es
        // gibt keine Spalte dafür. Wäre sie eine, müsste sie in den
        // Schnappschuss — solange sie eine Hauseigenschaft bleibt, ist sie
        // dieselbe wie beim Kontaktweg.
        creditorId: coolifyConfig.creditorId,
        registerIdentifier: r.issuerCommercialRegisterA ?? '',
        registerCourt: r.issuerRegisterCourt ?? '',
        generalPartner: {
          name: r.issuerGeneralPartner ?? '',
          seat: r.issuerGeneralPartnerSeat ?? '',
          registerCourt: r.issuerGeneralPartnerRegisterCourt ?? '',
          registerIdentifier: r.issuerGeneralPartnerCommercialRegisterB ?? '',
          managingDirector: (r.issuerManagingDirector ?? '')
            .split(',')
            .map((name) => name.trim())
            .filter((name) => name !== ''),
        },
        // Rückfrageweg aus der laufenden Konfiguration, siehe oben.
        contact: coolifyConfig.contact,
        bank: bankFrom(r.issuerBankDetails, coolifyConfig.bank),
        // BT-33 — der § 125a-HGB-Block als Fliesstext.
        //
        // [W3]: Der SITZ beider Gesellschaften gehört hinein. Er fehlte, und
        // damit widersprachen sich die beiden Geschäftsbriefe des Hauses: Die
        // Fusszeile der Rundmail nannte ihn, die Rechnung nicht.
        legalAddition: [
          r.issuerCompanyName,
          r.issuerSeat ? `Sitz ${r.issuerSeat}` : '',
          r.issuerRegisterCourt,
          r.issuerCommercialRegisterA,
        ]
          .filter((part) => (part ?? '') !== '')
          .join(', ') +
          (r.issuerGeneralPartner
            ? `. Persönlich haftende Gesellschafterin: ${r.issuerGeneralPartner}, ` +
              (r.issuerGeneralPartnerSeat
                ? `Sitz ${r.issuerGeneralPartnerSeat}, `
                : '') +
              `${r.issuerGeneralPartnerRegisterCourt ?? ''} ` +
              `${r.issuerGeneralPartnerCommercialRegisterB ?? ''}. ` +
              `Geschäftsführer: ${r.issuerManagingDirector ?? ''}.`
            : '.'),
      },
      recipient: {
        name: r.recipientName,
        address: {
          street: street.trim(),
          postalCode: separation?.[1] ?? '',
          city: separation?.[2] ?? postalCodeCity.trim(),
          country: country.trim() || 'DE',
        },
        ...(r.recipientEmail ? { email: r.recipientEmail } : {}),
      },
      lines,
      taxBreakdown,
      sumNetCent,
      sumTaxCent,
      sumGrossCent,
      prepaidCent: 0,
      paymentAmountCent: sumGrossCent,
      // ===================================================================
      // DIE VORABANKÜNDIGUNG — was das System zum Lastschrifteinzug beiträgt
      // ===================================================================
      //
      // Wird eingezogen, steht hier KEINE Zahlungsaufforderung, sondern die
      // Ankündigung. Der Unterschied ist nicht kosmetisch: „Zahlbar ohne
      // Abzug bis zum …" neben einem laufenden Einzug führt zur
      // Doppelzahlung, und die zurückzuholen macht mehr Arbeit als der ganze
      // Vorgang wert ist.
      //
      // MANDATSREFERENZ UND GLÄUBIGER-ID GEHÖREN BEIDE HINEIN. Ohne sie kann
      // die Kundin den Einzug bei ihrer Bank nicht zuordnen — und genau das
      // ist der Zweck der Ankündigung.
      paymentTerm: isCancellation
        ? 'Der Betrag wird erstattet bzw. mit offenen Forderungen verrechnet.'
        : r.directDebitMandateReference !== null
          ? preNotification(
              dueAt,
              r.directDebitMandateReference,
              coolifyConfig.creditorId,
            )
          : `Zahlbar ohne Abzug bis zum ${dateAsText(dueAt)}.`,
      hint:
        'Es gilt die Regelbesteuerung. Leistungszeitraum: ' +
        `${dateAsText(dateStringFromDate(r.servicePeriodFrom))} bis ` +
        `${dateAsText(dateStringFromDate(r.servicePeriodUntil))}.`,
      // Die beiden Texte des Bearbeiten-Screens. Leer heisst weg — eine
      // leere Zeile auf dem Beleg wäre schlechter als keine.
      ...(r.introduction ? { introduction: r.introduction } : {}),
      ...(r.paymentNote ? { paymentNote: r.paymentNote } : {}),
      ...(isCancellation
        ? {
            cancellationNote:
              `Stornorechnung zu Rechnung ${r.cancelledInvoice?.invoiceNumber ?? ''}` +
              (r.cancellationReason ? ` — ${r.cancellationReason}` : ''),
          }
        : {}),
    };
  }
}

/**
 * Zerlegt die gespeicherte Bankverbindung wieder in ihre Teile.
 *
 * Der Schnappschuss führt sie als eine Zeile („Sparkasse Fulda, IBAN DE…,
 * BIC …"), weil die Spalte in der Init-Migration so angelegt ist. Für das XML
 * werden IBAN und BIC einzeln gebraucht. Lässt sich die Zeile nicht zerlegen,
 * gilt die laufende Konfiguration — besser eine gültige Bankverbindung aus der
 * Umgebung als ein leeres Pflichtfeld im XML.
 */
function bankFrom(
  stored: string | null,
  preset: { institution: string; iban: string; bic: string },
): { institution: string; iban: string; bic: string } {
  if (stored === null) return preset;
  const iban = /IBAN\s+([A-Z]{2}[0-9A-Z]+)/i.exec(stored)?.[1];
  const bic = /BIC\s+([A-Z0-9]+)/i.exec(stored)?.[1];
  if (!iban) return preset;
  return {
    institution: stored.split(',')[0]?.trim() ?? preset.institution,
    iban,
    bic: bic ?? preset.bic,
  };
}
