import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { dateStringFromDate } from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import type { InquirySource } from '../common/inquiry-source';
import { PrismaService } from '../prisma/prisma.service';
import { IssuerConfigService } from './document/issuer.config';
import {
  documentIssuerFromCurrent,
  parseIssuerLayout,
} from './document/issuer-mapping';
import { createCii } from './document/cii-en16931';
import { createHtml, dateAsText } from './document/layout-html';
import type {
  CiiProfile,
  DocumentLine,
  DocumentTaxShare,
  InvoiceDocument,
} from './document/document.types';
import {
  INVOICE_RENDERER,
  type InvoiceRenderer,
} from './document/invoice-renderer.client';
import { decimalAsCent } from './invoice.amount';
import { LINE_ORDER } from './invoice.query';
import {
  InvoiceNotFoundError,
  InvoiceStatusMismatchError,
  InvoiceDocumentInvalidError,
  InvoiceDocumentDataError,
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

/** Die drei Ausgabeformate eines Belegs. */
export type DocumentFormat = 'pdf' | 'xml' | 'xrechnung';

export interface DeliveredDocument {
  content: Buffer;
  filename: string;
  contentType: string;
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * ===========================================================================
 * GENAU EINMAL ERZEUGEN, DANN NUR AUSLIEFERN (GoBD)
 * ===========================================================================
 *
 * Jedes der drei Dokumente (CII-XML nach EN 16931, ZUGFeRD-PDF/A-3b,
 * XRechnung-XML) entsteht höchstens EINMAL aus dem Schnappschuss, wird mit
 * seiner SHA-256-Prüfsumme gespeichert und danach nie wieder berührt. Das
 * passt zu den Datenbank-Triggern: Dokumentspalten wechseln nur von NULL auf
 * einen Wert. Das PDF bettet genau die gespeicherten XML-Bytes ein, damit
 * `xmlContent` und der strukturierte Teil des PDF identisch sind.
 */
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
   * Liefert ein Dokument im gewünschten Format aus — erzeugt es beim ersten
   * Mal — und PROTOKOLLIERT DEN ABRUF (`invoice.document_downloaded`, das
   * Format steht im Detail). Das ist der Weg der Download-Routen; der
   * Versand per Mail nutzt `getOrCreate` und protokolliert als `invoice.sent`.
   */
  async download(
    format: DocumentFormat,
    id: string,
    actor: Actor,
    source: InquirySource,
  ): Promise<DeliveredDocument> {
    let delivered: DeliveredDocument;
    let hash: string | null = null;
    if (format === 'pdf') {
      const { pdf, filename } = await this.getOrCreate(id, actor, source);
      delivered = { content: pdf, filename, contentType: 'application/pdf' };
      hash = sha256(pdf);
    } else if (format === 'xml') {
      const { xml, filename } = await this.getXml(id, actor, source);
      delivered = {
        content: xml,
        filename,
        contentType: 'application/xml; charset=utf-8',
      };
      hash = sha256(xml);
    } else {
      const { xml, filename } = await this.getXrechnung(id, actor, source);
      delivered = {
        content: xml,
        filename,
        contentType: 'application/xml; charset=utf-8',
      };
      hash = sha256(xml);
    }
    await this.audit.log({
      userId: actor.userId,
      actor: actor.name,
      action: AUDIT_ACTION.invoiceDocumentDownloaded,
      objectType: 'Invoice',
      objectId: id,
      afterValue: { format, sha256: hash, sizeBytes: delivered.content.byteLength },
      ...source,
    });
    return delivered;
  }

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

  /**
   * Erzeugt das ZUGFeRD-PDF und legt es mit seiner Prüfsumme an der Rechnung ab.
   *
   * Das eingebettete XML ist das gespeicherte `xmlContent` (siehe
   * `ensureXml`) — wird es hier zum ersten Mal gebraucht, entsteht es jetzt.
   */
  async create(
    id: string,
    actor: Actor,
    source: InquirySource,
  ): Promise<{ pdf: Buffer; filename: string }> {
    const document = await this.buildDocument(id);
    const html = createHtml(document);
    const xmlBytes = await this.ensureXml(id, document, actor, source);

    let pdf: Buffer;
    try {
      pdf = await this.renderer.create(html, xmlBytes.toString('utf8'), 'EN16931');
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
    // `updateMany` trifft nur, wenn die Spalte noch leer ist (NULL → Wert,
    // wie es der GoBD-Trigger verlangt). Wer das Rennen verliert, bekommt
    // `count: 0`, liest die GESPEICHERTE Fassung und gibt DIESE aus. Sein
    // eigenes PDF wird verworfen. Invariante: *Was ausgegeben wird, ist immer
    // das, was im Archiv liegt.* Keine Transaktion über den HTTP-Aufruf.
    const { count } = await this.prisma.invoice.updateMany({
      // NUR DIE DOKUMENTSPALTEN dieses Formats. Kein Betrag, kein Datum,
      // kein Status — diese Methode ist kein Änderungsbefehl (R2).
      where: { id, pdfContent: null },
      data: { pdfContent: pdf, pdfSha256: sha256(pdf) },
    });
    await this.stampGenerated(id);

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
        format: 'pdf',
        sizeBytes: pdf.byteLength,
        sha256: sha256(pdf),
      },
      ...source,
    });

    this.logger.log(
      `Rechnungsdokument ${document.number} erzeugt (${pdf.byteLength} Bytes).`,
    );
    return { pdf, filename: this.filename(document.number) };
  }

  /**
   * Das CII-XML (Factur-X, EN 16931) einzeln — für die Übergabe an die
   * Buchhaltung. UNABHÄNGIG VOM PDF: Fehlt es, wird es jetzt einmal
   * erzeugt und gespeichert; das PDF bettet später genau diese Bytes ein.
   */
  async getXml(
    id: string,
    actor: Actor,
    source: InquirySource,
  ): Promise<{ xml: Buffer; filename: string }> {
    const row = await this.prisma.invoice.findUnique({
      where: { id },
      select: { xmlContent: true, invoiceNumber: true, status: true },
    });
    if (!row) throw new InvoiceNotFoundError();
    if (row.status === 'draft') {
      throw new InvoiceStatusMismatchError('draft', 'finalized');
    }
    const xml =
      row.xmlContent !== null
        ? Buffer.from(row.xmlContent)
        : await this.ensureXml(id, await this.buildDocument(id), actor, source);
    return {
      xml,
      filename: `${this.core(row.invoiceNumber)}-factur-x.xml`,
    };
  }

  /**
   * Die XRechnung (CII, reines XML) — unabhängig vom PDF, einmal erzeugt.
   * Für Behörden (Leitweg-ID als Käuferreferenz).
   */
  async getXrechnung(
    id: string,
    actor: Actor,
    source: InquirySource,
  ): Promise<{ xml: Buffer; filename: string }> {
    const row = await this.prisma.invoice.findUnique({
      where: { id },
      select: { xrechnungContent: true, invoiceNumber: true, status: true },
    });
    if (!row) throw new InvoiceNotFoundError();
    if (row.status === 'draft') {
      throw new InvoiceStatusMismatchError('draft', 'finalized');
    }
    const filename = `${this.core(row.invoiceNumber)}-xrechnung.xml`;
    if (row.xrechnungContent !== null) {
      return { xml: Buffer.from(row.xrechnungContent), filename };
    }

    const document = await this.buildDocument(id);
    const xml = Buffer.from(this.cii(document, 'XRECHNUNG'), 'utf8');
    const { count } = await this.prisma.invoice.updateMany({
      where: { id, xrechnungContent: null },
      data: { xrechnungContent: xml, xrechnungSha256: sha256(xml) },
    });
    await this.stampGenerated(id);
    if (count === 0) {
      const stored = await this.prisma.invoice.findUnique({
        where: { id },
        select: { xrechnungContent: true },
      });
      if (stored?.xrechnungContent) {
        return { xml: Buffer.from(stored.xrechnungContent), filename };
      }
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
        format: 'xrechnung',
        sizeBytes: xml.byteLength,
        sha256: sha256(xml),
      },
      ...source,
    });
    return { xml, filename };
  }

  /**
   * Das gespeicherte EN-16931-XML — oder, falls noch keines existiert, das
   * jetzt EINMAL erzeugte. Wer das Rennen verliert, bekommt das gespeicherte.
   */
  private async ensureXml(
    id: string,
    document: InvoiceDocument,
    actor: Actor,
    source: InquirySource,
  ): Promise<Buffer> {
    const row = await this.prisma.invoice.findUnique({
      where: { id },
      select: { xmlContent: true },
    });
    if (row?.xmlContent) return Buffer.from(row.xmlContent);

    const xml = Buffer.from(this.cii(document, 'EN16931'), 'utf8');
    const { count } = await this.prisma.invoice.updateMany({
      where: { id, xmlContent: null },
      data: { xmlContent: xml, xmlSha256: sha256(xml) },
    });
    await this.stampGenerated(id);
    if (count === 0) {
      const stored = await this.prisma.invoice.findUnique({
        where: { id },
        select: { xmlContent: true },
      });
      if (stored?.xmlContent) return Buffer.from(stored.xmlContent);
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
        format: 'xml',
        sizeBytes: xml.byteLength,
        sha256: sha256(xml),
      },
      ...source,
    });
    return xml;
  }

  /** `documentGeneratedAt` einmalig setzen (NULL → Wert, trigger-konform). */
  private async stampGenerated(id: string): Promise<void> {
    await this.prisma.invoice.updateMany({
      where: { id, documentGeneratedAt: null },
      data: { documentGeneratedAt: new Date() },
    });
  }

  /** CII erzeugen; fehlende Pflichtangaben werden zu einer fachlichen Meldung. */
  private cii(document: InvoiceDocument, profile: CiiProfile): string {
    try {
      return createCii(document, profile);
    } catch (exception) {
      if (exception instanceof TypeError) {
        throw new InvoiceDocumentDataError(exception.message);
      }
      throw exception;
    }
  }

  private core(invoiceNumber: string | null): string {
    return `Rechnung-${(invoiceNumber ?? 'rechnung').replace(/[^\w-]/g, '')}`;
  }

  private filename(invoiceNumber: string | null): string {
    return `${this.core(invoiceNumber)}.pdf`;
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
        lines: { orderBy: LINE_ORDER },
        cancelledInvoice: { select: { invoiceNumber: true } },
      },
    });
    if (!r) throw new InvoiceNotFoundError();
    if (r.invoiceNumber === null) {
      throw new InvoiceStatusMismatchError(r.status, 'finalized');
    }

    const currentIssuer = await this.issuer.current();
    const coolifyConfig = currentIssuer.issuer;
    // GoBD: Darstellung aus dem Festschreibzeitpunkt; nur Altzeilen ohne
    // Schnappschuss fallen auf das aktuelle Profil zurück.
    const layout =
      parseIssuerLayout(r.issuerLayout) ??
      documentIssuerFromCurrent(currentIssuer);
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
      taxCategory: p.taxCategory,
      ...(p.taxExemptionReason ? { taxExemptionReason: p.taxExemptionReason } : {}),
      taxRate: Number(p.taxRate.toFixed(2)),
    }));

    // Die Steueraufteilung wird aus den GESPEICHERTEN Postenbeträgen neu
    // gebildet, nicht neu gerechnet: Was im Beleg steht, ist maßgeblich.
    const byRecord = new Map<string, DocumentTaxShare>();
    r.lines.forEach((p) => {
      const record = Number(p.taxRate.toFixed(2));
      const key = `${p.taxCategory}|${record}|${p.taxExemptionReason ?? ''}`;
      const entry = byRecord.get(key) ?? {
        category: p.taxCategory,
        record,
        ...(p.taxExemptionReason ? { exemptionReason: p.taxExemptionReason } : {}),
        basisCent: 0,
        taxCent: 0,
      };
      entry.basisCent += decimalAsCent(p.netAmount) ?? 0;
      entry.taxCent += decimalAsCent(p.taxAmount) ?? 0;
      byRecord.set(key, entry);
    });
    const taxBreakdown = [...byRecord.values()];

    const sumNetCent = lines.reduce((s, p) => s + p.netCent, 0);
    const sumTaxCent = taxBreakdown.reduce((s, t) => s + t.taxCent, 0);
    const sumGrossCent = sumNetCent + sumTaxCent;

    const dueAt = dateStringFromDate(r.dueDate);
    // Lastschrift nur, wenn der Beleg ein Mandat trägt UND als 59 ausgewiesen
    // ist; eine Stornorechnung wird nie eingezogen.
    const debit =
      r.paymentMeansCode === '59' &&
      r.directDebitMandateReference !== null &&
      r.cancelledInvoiceId === null;
    const isCancellation = r.cancelledInvoiceId !== null;

    return {
      number: r.invoiceNumber,
      invoiceDate: dateStringFromDate(r.invoiceDate),
      dueAt,
      currency: r.currency,
      servicePeriod: {
        from: dateStringFromDate(r.servicePeriodFrom),
        until: dateStringFromDate(r.servicePeriodUntil),
      },
      deliveryDate: dateStringFromDate(r.servicePeriodFrom),
      orderReference: r.invoiceNumber,
      ...(r.recipientBuyerReference
        ? { buyerReference: r.recipientBuyerReference }
        : {}),
      paymentMeansCode: debit ? '59' : '58',
      ...(debit
        ? {
            directDebit: {
              mandateReference: r.directDebitMandateReference as string,
              creditorId: coolifyConfig.creditorId,
            },
          }
        : {}),
      issuer: {
        legalForm: layout.legalForm,
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
        // Rückfrageweg: aus dem SCHNAPPSCHUSS (BR-DE-2, unveränderlich wie
        // jede Angabe des Belegs); nur bei älteren Zeilen ohne diese Felder
        // gilt die laufende Konfiguration.
        contact: {
          name: r.issuerContactName ?? coolifyConfig.contact.name,
          phone: r.issuerContactPhone ?? coolifyConfig.contact.phone,
          email: r.issuerContactEmail ?? coolifyConfig.contact.email,
        },
        // Bank STRUKTURIERT aus dem Schnappschuss; der Freitext wird nur noch
        // für Zeilen ohne die strukturierten Felder zerlegt.
        bank: r.issuerIban
          ? {
              institution: r.issuerBankName ?? '',
              iban: r.issuerIban,
              bic: r.issuerBic ?? '',
            }
          : bankFrom(r.issuerBankDetails, coolifyConfig.bank),
        // BT-33 — die Pflichtangaben des Geschäftsbriefs, Zeilen mit " | ".
        legalAddition: layout.legalAddition,
        // Darstellung: Zeilenblöcke, Logo und Akzentfarbe des Firmenprofils.
        // Aus `Invoice.issuerLayout` (beim Festschreiben eingefroren); nur
        // Altzeilen ohne Schnappschuss nehmen das geltende Profil.
        blocks: layout.blocks,
        logoDataUri: layout.logoDataUri,
        accentColor: layout.accentColor,
        taxNumber: layout.taxNumber ?? '',
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
        ...(r.recipientVatId ? { vatId: r.recipientVatId } : {}),
        ...(r.recipientElectronicAddress
          ? {
              electronicAddress: {
                id: r.recipientElectronicAddress,
                scheme: r.recipientElectronicAddressScheme ?? 'EM',
              },
            }
          : {}),
        ...(r.recipientBuyerType ? { buyerType: r.recipientBuyerType } : {}),
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
          : 'Zahlbar ohne Abzug bis zum Fälligkeitsdatum auf das unten genannte Konto, Verwendungszweck: Rechnungsnummer.',
      // Nur gesetzlich nötige Hinweise (Steuerbefreiung, Reverse Charge,
      // § 19 UStG als Befreiungsgrund der Posten). Bei Regelbesteuerung leer:
      // Der Leistungszeitraum steht schon in den Details des Belegs.
      hint: [
        ...new Set(
          r.lines
            .map((p) => p.taxExemptionReason)
            .filter((x): x is string => !!x),
        ),
      ]
        .map((reason) => `${reason}.`)
        .join(' '),
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
