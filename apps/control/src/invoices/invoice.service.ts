import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// `Prisma` als WERT, nicht nur als Typ: `Prisma.Decimal` und `Prisma.join`
// werden zur Laufzeit gebraucht.
import { Prisma } from '.prisma/control-client';
import type { InvoiceStatus } from '.prisma/control-client';
import { datePlusDays, dateStringFromDate, today, toDate } from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import type { InquirySource } from '../common/inquiry-source';
import { dayReadable } from '../common/calendar';
import { writeSystemNote } from '../notes/system-note';
import { CompanyNotFoundError } from '../companies/company.errors';
import { PrismaService } from '../prisma/prisma.service';
import { IssuerConfigService, isPlaceholderIssuer } from './document/issuer.config';
import { issuerLayoutSnapshot } from './document/issuer-mapping';
import { validateIssuerProfile } from '@saas-instant/shared';
import {
  type DateWindow,
  windowFrom,
  checkInvoiceDate,
} from './invoice-date-window';
import { PricingConfigService } from './pricing.config';
import { assignNextNumber } from './number-sequence';
import {
  calculate,
  centAsDecimal,
  checkTaxCategory,
  decimalAsCent,
  type LineInput,
  type TaxCategory,
} from './invoice.amount';
import {
  InvoiceAlreadyCancelledError,
  InvoiceIsFinalizedError,
  InvoiceNotFoundError,
  InvoiceStatusMismatchError,
  InvoiceIncompleteError,
  PriceTierUnknownError,
  InvoiceIssuerPlaceholderError,
  InvoiceIssuerIncompleteError,
  CancellationNotCancellableError,
} from './invoice.errors';
import {
  issuerSnapshot,
  recipientSnapshot,
  missingMandatoryDetails,
} from './invoice.snapshot';
import {
  sum,
  paymentStateFrom,
  type InvoiceResponse,
  type PaymentState,
} from './invoice.response';

/** Eine Seite der globalen Rechnungsliste. */
export interface InvoicePage {
  invoices: InvoiceResponse[];
  total: number;
  page: number;
  perPage: number;
  /**
   * Menge je Zahlungsstand — die Zahlen der Filterchips.
   *
   * Sie beachten den ORGANISATIONSFILTER nicht und den Standfilter erst
   * recht nicht: Sonst zeigte jeder Chip ausser dem gewaehlten eine Null.
   */
  countPerState: Record<PaymentState, number>;
}

/** Die drei Zahlen der Kennzahlkacheln. */
export interface InvoiceMetrics {
  year: number;
  openCent: number;
  openCount: number;
  overdueCent: number;
  overdueCount: number;
  paidCent: number;
}

/** Zaehlt jeden Zahlungsstand einmal durch. */
function countPerState(
  rows: readonly {
    status: InvoiceStatus;
    dueDate: Date;
    paidAmount: Prisma.Decimal | null;
    cancelledInvoiceId?: string | null;
    lines: readonly { grossAmount: Prisma.Decimal }[];
  }[],
  todayDay: string,
): Record<PaymentState, number> {
  const counter: Record<PaymentState, number> = {
    draft: 0,
    open: 0,
    overdue: 0,
    partially_paid: 0,
    paid: 0,
    cancelled: 0,
  };
  for (const row of rows) {
    counter[
      paymentStateFrom(row, sum(row.lines, 'grossAmount'), todayDay)
    ] += 1;
  }
  return counter;
}
import {
  RESPONSE_FIELDS,
  HEADER_FIELDS,
  getInvoice,
  withDocumentMarker,
  lockInvoice,
  LINE_ORDER,
} from './invoice.query';
import type { InvoiceDraftDto } from './dto/invoice.dto';

/** Wer die Handlung ausgelöst hat — dieselbe Form wie im InstanzService. */
export interface Actor {
  userId: string | null;
  name: string;
}

/**
 * Zustände, aus denen heraus eine Rechnung noch ein ENTWURF ist.
 *
 * Genau einer. Die Liste steht trotzdem als Konstante da, weil sie an drei
 * Stellen gebraucht wird und ein vierter Zustand sonst unbemerkt durchrutschen
 * könnte.
 */
const DRAFT: InvoiceStatus[] = ['draft'];

/** Zustände, aus denen heraus storniert werden darf. */
const CANCELLABLE: InvoiceStatus[] = [
  'finalized',
  'sent',
  'paid',
  'partially_paid',
  'overdue',
];

/**
 * DAS RECHNUNGSMODUL.
 *
 * ===========================================================================
 * HARTE REGEL R2 — UND WIE SIE HIER DURCHGESETZT WIRD
 * ===========================================================================
 *
 * „Nach dem Festschreiben existiert kein Löschbefehl und kein Änderungsbefehl
 * für eine Rechnung — nicht im UI, nicht in der API, nicht in einem Service.
 * Korrekturen laufen ausschließlich über Storno."
 *
 * Dieser Dienst hat GENAU SECHS schreibende Methoden, und keine von ihnen ist
 * ein allgemeines „ändere Rechnung":
 *
 *   entwurfAnlegen    schreibt nur neue Zeilen im Zustand `entwurf`
 *   entwurfAendern    weist alles ab, was nicht `entwurf` ist
 *   entwurfLoeschen   weist alles ab, was nicht `entwurf` ist
 *   festschreiben     `entwurf` → `festgeschrieben`, vergibt die Nummer
 *   storniere         legt eine ZWEITE Rechnung an, ändert am Original nur
 *                     den Status
 *   versandVermerken  setzt `festgeschrieben` → `versendet`
 *
 * Dazu kommen aus getrennten Diensten: `PaymentService` (Zahldatum, gezahlter
 * Betrag, Übertragungsvermerk) und `InvoiceDocumentService` (das erzeugte
 * PDF). Beide fassen ausdrücklich KEINE Beträge, keine Posten, keinen
 * Schnappschuss und keine Nummer an.
 *
 * `invoice-immutable.spec.ts` zählt diese Menge über den Quellbaum ab.
 * Die Zusage ist damit geprüft und nicht bloß aufgeschrieben.
 *
 * ===========================================================================
 * DER SCHNAPPSCHUSS
 * ===========================================================================
 *
 * Empfänger- und Ausstellerdaten werden BEIM FESTSCHREIBEN aus der
 * Organisation bzw. der Ausstellerkonfiguration in die Rechnung kopiert — in
 * derselben Transaktion wie die Nummernvergabe. Der Entwurf trägt dieselben
 * Felder bereits, aber nur als Vorschau; sie werden beim Festschreiben frisch
 * gelesen.
 *
 * Der Grund für „frisch beim Festschreiben" statt „stehenlassen, was im
 * Entwurf steht": Ein Entwurf kann Wochen alt sein. Stünde die Adresse von
 * damals im Beleg, ginge die Rechnung an eine Anschrift, die die Kundin
 * inzwischen berichtigt hat — und niemand sähe den Unterschied.
 */
@Injectable()
export class InvoiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly prices: PricingConfigService,
    private readonly issuer: IssuerConfigService,
    /**
     * [W1]: Das zulässige Fenster für das Rechnungsdatum. Steht in der
     * Umgebung und nicht im Code, weil es eine BETRIEBLICHE Entscheidung ist —
     * wer wirklich weiter zurück buchen muss, soll das bewusst tun können.
     */
    private readonly config: ConfigService,
  ) {}

  /** Das geltende Fenster für das Rechnungsdatum. */
  private dateWindow(): DateWindow {
    return windowFrom((name) => this.config.get<string>(name));
  }

  // ------------------------------------------------------------------ lesen

  /** Alle Rechnungen einer Organisation, die neueste zuerst. */
  async listForCompany(
    companyId: string,
    limit = 100,
  ): Promise<InvoiceResponse[]> {
    const rows = await this.prisma.invoice.findMany({
      where: { companyId },
      select: RESPONSE_FIELDS,
      orderBy: [{ invoiceDate: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });
    return withDocumentMarker(this.prisma, rows);
  }

  /**
   * ALLE Rechnungen, gefiltert nach Zahlungsstand und mit Seiten.
   *
   * BIS ZUM REDESIGN GAB ES DIESE LISTE BEWUSST NICHT. Die Begruendung stand
   * in `RechnungenKarte`: Rechnungen gehoeren zu einer Organisation, und die
   * uebergreifende Frage („was ist ueberfaellig") beantwortete das Dashboard
   * bereits arbeitsorientiert. Der Entwurf kehrt das um, und das ist
   * nachvollziehbar: Wer einen Abrechnungslauf macht, arbeitet nicht Kunde
   * fuer Kunde, sondern Rechnung fuer Rechnung.
   *
   * DER FILTER LAEUFT UEBER DEN ABGELEITETEN ZAHLUNGSSTAND, nicht ueber die
   * Statusspalte. „Offen" und „ueberfaellig" unterscheiden sich nur am
   * Faelligkeitsdatum gegen HEUTE — in SQL waere das eine zweite Fassung von
   * `paymentStateFrom`, und die beiden liefen eines Tages auseinander.
   *
   * Der Preis dafuer steht hier offen: Es wird mehr gelesen als am Ende
   * gezeigt. Bei einem Haus mit ein paar hundert Rechnungen im Jahr ist das
   * die richtige Seite des Tauschs; wuerde die Zahl vierstellig, gehoerte
   * `zahlungsstand` als gepflegte Spalte ins Schema.
   */
  async list(filter: {
    state?: PaymentState;
    companyId?: string;
    page?: number;
    perPage?: number;
  }): Promise<InvoicePage> {
    const page = Math.max(1, filter.page ?? 1);
    const perPage = Math.min(200, Math.max(1, filter.perPage ?? 25));

    const rows = await this.prisma.invoice.findMany({
      where: filter.companyId
        ? { companyId: filter.companyId }
        : {},
      select: RESPONSE_FIELDS,
      orderBy: [{ invoiceDate: 'desc' }, { createdAt: 'desc' }],
    });

    const todayDay = today();
    const matching =
      filter.state === undefined
        ? rows
        : rows.filter(
            (z) =>
              paymentStateFrom(z, sum(z.lines, 'grossAmount'), todayDay) ===
              filter.state,
          );

    const excerpt = matching.slice((page - 1) * perPage, page * perPage);

    return {
      invoices: await withDocumentMarker(this.prisma, excerpt),
      total: matching.length,
      page,
      perPage,
      countPerState: countPerState(rows, todayDay),
    };
  }

  /**
   * Die drei Zahlen der Kennzahlkacheln.
   *
   * OFFENE UND UEBERFAELLIGE BETRAEGE sind das, was noch hereinkommen muss —
   * abzueglich dessen, was schon gezahlt wurde. BEZAHLTER UMSATZ ist die
   * Summe der ausgeglichenen Rechnungen des Jahres, nach RECHNUNGSDATUM und
   * nicht nach Zahldatum: Sonst wanderte eine Rechnung von 2026, die im
   * Januar 2027 bezahlt wird, in den Umsatz von 2027.
   *
   * [H2] ORIGINAL UND STORNO FALLEN SYMMETRISCH HERAUS. Beide stehen im
   * Zustand `cancelled` (siehe `paymentStateFrom`) und zaehlen weder als
   * offen noch als ueberfaellig noch als bezahlter Umsatz. Der Umsatz der
   * beiden ist zusammen null — sie auch einzeln wegzulassen liefert dieselbe
   * Summe, ohne dass es auf den Vermerk der Erstattung ankommt. Vorher stand
   * das Original (storniert, ausgeschlossen) allein gegen einen Storno mit
   * negativem Betrag, und „Bezahlter Umsatz" wurde negativ, sobald dort die
   * Erstattung vermerkt war.
   */
  async metrics(year?: number): Promise<InvoiceMetrics> {
    const todayDay = today();
    const referenceYear = year ?? Number(todayDay.slice(0, 4));

    const rows = await this.prisma.invoice.findMany({
      select: {
        ...RESPONSE_FIELDS,
      },
    });

    let openCent = 0;
    let overdueCent = 0;
    let openCount = 0;
    let overdueCount = 0;
    let paidCent = 0;

    for (const row of rows) {
      const gross = sum(row.lines, 'grossAmount');
      // [H2] Stornorechnungen (und jede andere negative Summe) tragen nichts
      // zu Offen, Überfällig oder Umsatz bei: Ihr Original steht im Zustand
      // `cancelled` und ist ebenfalls draußen — beide heben sich auf, und es
      // kommt nicht darauf an, ob an der Stornorechnung eine Erstattung
      // vermerkt wurde. Die Zeile hier gilt auch dann, wenn ein Aufrufer
      // `cancelledInvoiceId` nicht mitgeladen hat.
      if (gross < 0) continue;
      const state = paymentStateFrom(row, gross, todayDay);
      const paid = decimalAsCent(row.paidAmount) ?? 0;

      // OFFEN UND UEBERFAELLIG SIND GETRENNT, sie ueberschneiden sich nicht.
      //
      // Naheliegend waere, „offen" als „alles noch nicht Bezahlte" zu lesen —
      // dann enthielte es das Ueberfaellige. Daneben steht aber der Chip
      // „Offen" mit dem STRENGEN Wert, und die Kachel sagte „1 Rechnung",
      // waehrend der Chip „0" zeigt. Genau so stand es beim ersten Blick auf
      // die fertige Seite. Die Kachel folgt jetzt derselben Trennung wie die
      // Chips; wer die Summe will, addiert zwei Zahlen, die beide stimmen.
      const rest = gross - paid;
      if (state === 'open') {
        openCent += rest;
        openCount += 1;
      } else if (state === 'overdue') {
        overdueCent += rest;
        overdueCount += 1;
      }

      if (
        state === 'paid' &&
        dateStringFromDate(row.invoiceDate).startsWith(String(referenceYear))
      ) {
        paidCent += gross;
      }
    }

    return {
      year: referenceYear,
      openCent,
      openCount,
      overdueCent,
      overdueCount,
      paidCent,
    };
  }

  /** Eine einzelne Rechnung. */
  async get(id: string): Promise<InvoiceResponse> {
    return getInvoice(this.prisma, id);
  }

  // --------------------------------------------------------------- Entwurf

  /**
   * Legt einen Entwurf an. NOCH OHNE NUMMER — die vergibt erst das
   * Festschreiben (R2).
   */
  async draftCreate(
    companyId: string,
    dto: InvoiceDraftDto,
    actor: Actor,
    source: InquirySource,
  ): Promise<InvoiceResponse> {
    const table = this.prices.read();
    const data = await this.draftData(companyId, dto, table.paymentDueDays);

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.invoice.create({
        data: { companyId, ...data.invoice },
        select: { id: true },
      });
      await tx.invoiceLine.createMany({
        data: data.lines.map((p) => ({ ...p, invoiceId: created.id })),
      });
      await this.audit.log(
        {
          userId: actor.userId,
          actor: actor.name,
          action: AUDIT_ACTION.invoiceDraftCreated,
          objectType: 'Invoice',
          objectId: created.id,
          // NUR BETRÄGE UND ZEITRÄUME. Empfängername und Anschrift stehen
          // bewusst nicht im Nachweis: Die Sperrliste aus Etappe 2 räumt sie
          // ohnehin ab (`name`, `strasse`, `plz`, `ort`), und das Audit-Log
          // hat keinen Löschweg.
          afterValue: {
            companyId,
            invoiceDate: dto.invoiceDate,
            servicePeriodFrom: dto.servicePeriodFrom,
            servicePeriodUntil: dto.servicePeriodUntil,
            linesCount: data.lines.length,
            sumGrossCent: data.sumGrossCent,
          },
          ...source,
        },
        tx,
      );
      return created;
    });

    return this.get(row.id);
  }

  /**
   * Ändert einen Entwurf — und NUR einen Entwurf.
   *
   * Die Posten werden ersetzt, nicht ergänzt. Alles andere führte zu einem
   * Entwurf, der aus zwei Bearbeitungsständen besteht.
   */
  async draftUpdate(
    id: string,
    dto: InvoiceDraftDto,
    actor: Actor,
    source: InquirySource,
  ): Promise<InvoiceResponse> {
    const table = this.prices.read();

    await this.prisma.$transaction(async (tx) => {
      const before = await this.lockAndCheck(tx, id, DRAFT);
      const data = await this.draftData(
        before.companyId,
        dto,
        table.paymentDueDays,
        tx,
      );

      await tx.invoice.update({ where: { id }, data: data.invoice });
      // Posten eines ENTWURFS. Der einzige Löschaufruf gegen
      // `Rechnungsposten` im ganzen Programm, und er steht hinter
      // `lockAndCheck(… ENTWURF)`.
      await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
      await tx.invoiceLine.createMany({
        data: data.lines.map((p) => ({ ...p, invoiceId: id })),
      });

      await this.audit.log(
        {
          userId: actor.userId,
          actor: actor.name,
          action: AUDIT_ACTION.invoiceDraftUpdated,
          objectType: 'Invoice',
          objectId: id,
          afterValue: {
            invoiceDate: dto.invoiceDate,
            linesCount: data.lines.length,
            sumGrossCent: data.sumGrossCent,
          },
          ...source,
        },
        tx,
      );
    });

    return this.get(id);
  }

  /**
   * Löscht einen Entwurf.
   *
   * DAS IST DER EINZIGE LÖSCHPFAD DES MODULS, und er endet am Zustand
   * `entwurf`. Ein Entwurf ist kein Beleg: Er hat keine Nummer, er war nie
   * draußen, und ihn stehenzulassen produzierte eine Liste aus Versuchen. Ab
   * dem Festschreiben gibt es keinen Löschbefehl mehr — auch nicht hier.
   */
  async draftDelete(
    id: string,
    actor: Actor,
    source: InquirySource,
  ): Promise<{ deleted: true }> {
    await this.prisma.$transaction(async (tx) => {
      const before = await this.lockAndCheck(tx, id, DRAFT);
      await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
      await tx.invoice.delete({ where: { id } });
      await this.audit.log(
        {
          userId: actor.userId,
          actor: actor.name,
          action: AUDIT_ACTION.invoiceDraftDeleted,
          objectType: 'Invoice',
          objectId: id,
          beforeValue: {
            companyId: before.companyId,
            invoiceDate: dateStringFromDate(before.invoiceDate),
          },
          ...source,
        },
        tx,
      );
    });
    return { deleted: true };
  }

  // --------------------------------------------------------- Festschreiben

  /**
   * DAS FESTSCHREIBEN — Nummer, Schnappschuss und Zustandswechsel in EINER
   * Transaktion.
   *
   * Die Reihenfolge in der Transaktion ist nicht beliebig:
   * 1. Rechnungszeile sperren (`FOR UPDATE`) und Zustand prüfen. Ohne das
   *    könnten zwei gleichzeitige Aufrufe für DIESELBE Rechnung beide „ist
   *    noch Entwurf" sehen und zwei Nummern verbrauchen.
   * 2. Schnappschuss frisch aus der Organisation lesen.
   * 3. Pflichtangaben prüfen — VOR der Nummernvergabe. Ein Abbruch danach
   *    wäre zwar lückenlos (die Sperre fällt beim Rollback), aber die Prüfung
   *    gehört trotzdem vor die Sperre auf den Nummernkreis: Sie hält den
   *    Kreis nicht unnötig fest.
   * 4. Nummer vergeben (Beratungssperre auf dem Jahr).
   * 5. Schreiben und protokollieren.
   *
   * KEIN HTTP IN DIESER TRANSAKTION. Das PDF entsteht danach, in einem
   * getrennten Schritt. Ein Rechnungsdienst, der zwanzig Sekunden braucht,
   * hielte sonst die Sperre auf dem gesamten Nummernkreis des Jahres — und ein
   * Zeitablauf mitten in der Transaktion machte aus einem Netzproblem eine
   * verlorene Rechnung.
   */
  async finalize(
    id: string,
    actor: Actor,
    source: InquirySource,
  ): Promise<InvoiceResponse> {
    await this.prisma.$transaction(
      async (tx) => {
        const draft = await this.lockAndCheck(tx, id, DRAFT);

        const company = await tx.company.findUnique({
          where: { id: draft.companyId },
          select: {
            name: true,
            street: true,
            houseNumber: true,
            postalCode: true,
            city: true,
            country: true,
            billingName: true,
            billingStreet: true,
            billingHouseNumber: true,
            billingPostalCode: true,
            billingCity: true,
            billingCountry: true,
            billingEmail: true,
            contactEmail: true,
            buyerType: true,
            vatId: true,
            buyerReference: true,
            electronicAddress: true,
            electronicAddressScheme: true,
            // [N8d] Zahlungsart und Mandat wie der übrige Schnappschuss
            // FRISCH lesen: Ein Entwurf kann Wochen alt sein, und ein
            // inzwischen widerrufenes Mandat darf nicht mehr als
            // Vorabankündigung auf dem Beleg stehen (bzw. ein neues muss).
            paymentMethod: true,
            sepaMandateReference: true,
          },
        });
        if (!company) throw new CompanyNotFoundError();

        const recipient = recipientSnapshot(company);
        const issuerNow = await this.issuer.current();
        const issuerConfig = issuerNow.issuer;
        // PLATZHALTER-AUSSTELLER: kein Beleg. Geprüft VOR der Nummernvergabe,
        // damit keine Nummer für ein Muster verbraucht wird.
        if (isPlaceholderIssuer(issuerConfig)) {
          throw new InvoiceIssuerPlaceholderError();
        }
        // DIE PFLICHTANGABEN JE RECHTSFORM (Einstellungen → Firmendaten),
        // ebenfalls VOR der Nummernvergabe. Jedes fehlende Feld wird genannt.
        const issuerIssues = validateIssuerProfile(issuerNow.profile);
        if (issuerIssues.length > 0) {
          throw new InvoiceIssuerIncompleteError(issuerIssues);
        }
        const issuerData = {
          ...issuerSnapshot(issuerConfig),
          issuerLayout: issuerLayoutSnapshot(issuerNow) as unknown as Prisma.InputJsonValue,
        };
        const linesCount = await tx.invoiceLine.count({
          where: { invoiceId: id },
        });

        const missing = missingMandatoryDetails({
          ...recipient,
          linesCount,
        });
        if (missing.length > 0) throw new InvoiceIncompleteError(missing);

        // [W1] DIE ZWEITE UND ENTSCHEIDENDE PRÜFUNG — unmittelbar VOR der
        // Nummernvergabe.
        //
        // Beim Entwurf wurde sie schon einmal durchgeführt; das genügt nicht.
        // Ein Entwurf kann Wochen liegen bleiben und dabei aus dem Fenster
        // laufen, und Entwürfe aus der Zeit vor [W1] haben sie nie gesehen.
        // Danach gibt es keine Korrektur mehr: Die Nummer ist vergeben, der
        // Beleg unveränderlich (R2).
        checkInvoiceDate(
          dateStringFromDate(draft.invoiceDate),
          this.dateWindow(),
        );

        // DIE NUMMER — erst hier, in derselben Transaktion, mit Sperre.
        // DER NUMMERNKREIS HÄNGT AM RECHNUNGSDATUM, nicht am heutigen Tag:
        // Eine am 2. Januar geschriebene Rechnung mit Datum vom 31. Dezember
        // gehört in den Kreis des alten Jahres. Sonst entstünde dort eine
        // Lücke — die Nummer wäre vergeben, die Rechnung stünde im neuen Jahr.
        const year = Number(dateStringFromDate(draft.invoiceDate).slice(0, 4));
        const invoiceNumber = await assignNextNumber(tx, year);

        // [M16] Eine aus dem Zahlungsziel abgeleitete Fälligkeit wird mit dem
        // dann geltenden Ziel aus dem Rechnungsdatum neu gebildet; eine von
        // Hand gesetzte bleibt. Danach die Plausibilitätsprüfung — auch für
        // Entwürfe aus der Zeit vor der Prüfung beim Speichern.
        const invoiceDay = dateStringFromDate(draft.invoiceDate);
        const dueDay = draft.dueDateManual
          ? dateStringFromDate(draft.dueDate)
          : datePlusDays(invoiceDay, this.prices.read().paymentDueDays);
        if (dueDay < invoiceDay) {
          throw new InvoiceIncompleteError([
            'Die Fälligkeit liegt vor dem Rechnungsdatum.',
          ]);
        }

        const finalizedAt = new Date();
        await tx.invoice.update({
          where: { id },
          data: {
            invoiceNumber,
            dueDate: toDate(dueDay),
            paymentMeansCode: paymentMeansCodeFor(company),
            directDebitMandateReference: mandateReferenceFor(company),
            status: 'finalized',
            finalizedAt,
            // AUFBEWAHRUNG: Ende des Festschreibungsjahres + n Jahre
            // (Manifest `billing.retentionYears`, Vorgabe 8).
            retentionUntil: retentionEnd(finalizedAt, this.issuer.retentionYears()),
            ...recipient,
            ...issuerData,
          },
        });

        await writeSystemNote(
          tx,
          draft.companyId,
          `Rechnung ${invoiceNumber} festgeschrieben, ` +
            `${dayReadable(dateStringFromDate(draft.invoiceDate))}`,
          dateStringFromDate(draft.invoiceDate),
        );

        await this.audit.log(
          {
            userId: actor.userId,
            actor: actor.name,
            action: AUDIT_ACTION.invoiceFinalized,
            objectType: 'Invoice',
            objectId: id,
            beforeValue: { status: 'draft' },
            afterValue: {
              status: 'finalized',
              invoiceNumber,
              companyId: draft.companyId,
            },
            ...source,
          },
          tx,
        );
      },
      {
        // AUSDRÜCKLICH READ COMMITTED. Der Nummernkreis setzt es voraus: Nur
        // hier sieht eine Transaktion, die auf die Beratungssperre gewartet
        // hat, die inzwischen festgeschriebene Zeile der Vorgängerin. Unter
        // REPEATABLE READ läge ihr Schnappschuss vor der Sperre, und sie
        // vergäbe dieselbe Nummer noch einmal. Es ist der Vorgabewert von
        // PostgreSQL — er steht hier, damit die Voraussetzung im Code
        // nachlesbar ist und nicht in einer Serverkonfiguration.
        isolationLevel: 'ReadCommitted',
        // Zwanzig gleichzeitige Festschreibungen laufen nacheinander durch die
        // Jahressperre. Die Vorgabe von fünf Sekunden reichte dafür nicht.
        timeout: 20_000,
      },
    );

    return this.get(id);
  }

  // ----------------------------------------------------------------- Storno

  /**
   * DIE STORNORECHNUNG — der einzige Weg, eine festgeschriebene Rechnung zu
   * korrigieren.
   *
   * „Neue Rechnung mit negativem Betrag, gegenseitiger Verweis, beide bleiben
   * bestehen." Der Auftrag nennt auch den ersten Anwendungsfall, und es ist
   * nicht der Kundenwunsch: der eigene Tippfehler bei Stufe, Zeitraum oder
   * Adresse. Ohne Storno bliebe nur ein Eingriff in die Datenbank — und genau
   * der ist ausgeschlossen.
   *
   * DER SCHNAPPSCHUSS DER STORNORECHNUNG KOMMT VOM ORIGINAL, nicht aus der
   * Organisation. Eine Stornorechnung, die eine inzwischen geänderte Adresse
   * trägt, hebt die ursprüngliche Rechnung nicht sichtbar auf — sie sähe aus
   * wie ein zweiter Vorgang. Das ist zugleich der Grund, warum sich eine
   * Rechnung an eine gelöschte Kundin noch stornieren lässt.
   *
   * ZWEI SCHRANKEN GEGEN DAS DOPPELTE STORNO:
   * 1. `FOR UPDATE` auf dem Original plus Zustandsprüfung.
   * 2. `Rechnung.cancelledInvoiceId` ist `@unique`. Selbst wenn (1)
   *    umgangen würde, ließe die Datenbank keine zweite Stornorechnung zu.
   */
  async cancel(
    id: string,
    reason: string,
    actor: Actor,
    source: InquirySource,
  ): Promise<{ original: InvoiceResponse; cancellation: InvoiceResponse }> {
    const todayDay = today();

    const cancellationId = await this.prisma.$transaction(
      async (tx) => {
        const original = await this.lockAndCheck(tx, id, CANCELLABLE);
        // Darstellung des Originals (nicht in HEADER_FIELDS: enthält das Logo).
        const originalLayout = await tx.invoice.findUnique({
          where: { id },
          select: { issuerLayout: true },
        });

        if (original.cancelledInvoiceId !== null) {
          throw new CancellationNotCancellableError();
        }
        const existingCancellation = await tx.invoice.findUnique({
          where: { cancelledInvoiceId: id },
          select: { invoiceNumber: true },
        });
        if (existingCancellation !== null) {
          throw new InvoiceAlreadyCancelledError(existingCancellation.invoiceNumber);
        }

        const lines = await tx.invoiceLine.findMany({
          where: { invoiceId: id },
          // [M11] Die Stornorechnung übernimmt die Reihenfolge des Originals
          // (vorher nach Bezeichnung, das mischte die Posten).
          orderBy: LINE_ORDER,
        });

        const year = Number(todayDay.slice(0, 4));
        const invoiceNumber = await assignNextNumber(tx, year);

        const cancellation = await tx.invoice.create({
          data: {
            companyId: original.companyId,
            invoiceNumber,
            status: 'finalized',
            finalizedAt: new Date(),
            invoiceDate: toDate(todayDay),
            // Der Leistungszeitraum bleibt der des Originals: Storniert wird
            // die Leistung von damals, nicht eine von heute.
            servicePeriodFrom: original.servicePeriodFrom,
            servicePeriodUntil: original.servicePeriodUntil,
            // Eine Stornorechnung ist sofort fällig — es ist nichts mehr zu
            // zahlen.
            dueDate: toDate(todayDay),
            cancelledInvoiceId: original.id,
            cancellationReason: reason.trim(),
            // SCHNAPPSCHUSS VOM ORIGINAL, Feld für Feld.
            recipientName: original.recipientName,
            recipientAddress: original.recipientAddress,
            recipientEmail: original.recipientEmail,
            recipientBuyerType: original.recipientBuyerType,
            recipientVatId: original.recipientVatId,
            recipientBuyerReference: original.recipientBuyerReference,
            recipientElectronicAddress: original.recipientElectronicAddress,
            recipientElectronicAddressScheme:
              original.recipientElectronicAddressScheme,
            currency: original.currency,
            // Eine Stornorechnung wird nie eingezogen: immer 58.
            paymentMeansCode: '58',
            retentionUntil: retentionEnd(new Date(), this.issuer.retentionYears()),
            issuerContactName: original.issuerContactName,
            issuerContactPhone: original.issuerContactPhone,
            issuerContactEmail: original.issuerContactEmail,
            issuerIban: original.issuerIban,
            issuerBic: original.issuerBic,
            issuerBankName: original.issuerBankName,
            issuerCompanyName: original.issuerCompanyName,
            issuerAddress: original.issuerAddress,
            issuerVatId: original.issuerVatId,
            issuerSeat: original.issuerSeat,
            issuerRegisterCourt: original.issuerRegisterCourt,
            issuerCommercialRegisterA: original.issuerCommercialRegisterA,
            issuerGeneralPartner: original.issuerGeneralPartner,
            issuerGeneralPartnerSeat: original.issuerGeneralPartnerSeat,
            issuerGeneralPartnerRegisterCourt:
              original.issuerGeneralPartnerRegisterCourt,
            issuerGeneralPartnerCommercialRegisterB: original.issuerGeneralPartnerCommercialRegisterB,
            issuerManagingDirector: original.issuerManagingDirector,
            issuerBankDetails: original.issuerBankDetails,
            issuerLayout:
              (originalLayout?.issuerLayout as Prisma.InputJsonValue | null) ??
              Prisma.DbNull,
          },
          select: { id: true },
        });

        await tx.invoiceLine.createMany({
          data: lines.map((p, index) => {
            const netCent = -(decimalAsCent(p.netAmount) ?? 0);
            const taxCent = -(decimalAsCent(p.taxAmount) ?? 0);
            return {
              invoiceId: cancellation.id,
              position: index,
              label: `Storno: ${p.label}`,
              // Einheit, Beschreibung und Zeitraum werden MITGENOMMEN: Ein
              // Storno nimmt dieselbe Leistung zurück, die berechnet wurde —
              // in derselben Einheit, für denselben Zeitraum. Ohne sie stünde
              // auf der Gutschrift eine andere Leistung als auf der Rechnung.
              //
              // NICHT mitgenommen werden Einleitung und Zahlungshinweis des
              // Kopfes: Auf einer Stornorechnung ist nichts zu zahlen, und
              // ein „Bitte überweisen Sie bis …" wäre dort schlicht falsch.
              // Ihren eigenen Text hat sie im Stornohinweis.
              unit: p.unit,
              description: p.description,
              periodFrom: p.periodFrom,
              periodUntil: p.periodUntil,
              // Die MENGE wird negiert, nicht der Einzelpreis. So bleibt auf
              // dem Dokument sichtbar, was zu welchem Preis zurückgenommen
              // wird — ein negativer Einzelpreis läse sich wie ein Rabatt.
              quantity: p.quantity.negated(),
              unitPriceNet: p.unitPriceNet,
              taxRate: p.taxRate,
              taxCategory: p.taxCategory,
              taxExemptionReason: p.taxExemptionReason,
              netAmount: centAsDecimal(netCent),
              taxAmount: centAsDecimal(taxCent),
              grossAmount: centAsDecimal(netCent + taxCent),
            };
          }),
        });

        // AM ORIGINAL ÄNDERT SICH GENAU EIN FELD: der Status. Beträge, Posten,
        // Nummer und Schnappschuss bleiben unangetastet — die Rechnung bleibt
        // vollständig lesbar, so wie sie hinausgegangen ist.
        await tx.invoice.update({
          where: { id },
          data: { status: 'cancelled' },
        });

        await writeSystemNote(
          tx,
          original.companyId,
          `Rechnung ${original.invoiceNumber ?? ''} storniert mit ` +
            `${invoiceNumber}, ${dayReadable(todayDay)}`,
          todayDay,
        );

        await this.audit.log(
          {
            userId: actor.userId,
            actor: actor.name,
            action: AUDIT_ACTION.invoiceCancelled,
            objectType: 'Invoice',
            objectId: id,
            beforeValue: {
              status: original.status,
              invoiceNumber: original.invoiceNumber,
            },
            afterValue: {
              status: 'cancelled',
              cancellationNumber: invoiceNumber,
              cancellationId: cancellation.id,
              // Der Grund ist vom Menschen getippter Freitext. Er steht als
              // Spalte auf der Stornorechnung, wo er hingehört — im
              // Audit-Log stünde er unlöschbar ([W3]).
              reasonStored: true,
            },
            ...source,
          },
          tx,
        );

        return cancellation.id;
      },
      { isolationLevel: 'ReadCommitted', timeout: 20_000 },
    );

    return { original: await this.get(id), cancellation: await this.get(cancellationId) };
  }

  // ---------------------------------------------------------------- Versand

  /**
   * Vermerkt, dass die Rechnung hinausgegangen ist.
   *
   * Getrennt vom eigentlichen Versand, weil der Versand selbst scheitern kann:
   * Erst wenn die Mail draußen ist, wird vermerkt. Der Zustandswechsel ist
   * einseitig — aus `versendet` wird nie wieder `festgeschrieben`.
   */
  async sendNote(id: string, db = this.prisma): Promise<void> {
    await db.invoice.updateMany({
      where: { id, status: 'finalized' },
      data: { status: 'sent' },
    });
  }

  // ----------------------------------------------------------------- intern

  /**
   * Sperrt die Rechnungszeile und prüft ihren Zustand.
   *
   * ZWEI DINGE IN EINER METHODE, und das ist Absicht: Wer den Zustand prüft,
   * ohne die Zeile zu sperren, hat ein „check-then-act" gebaut — zwei
   * gleichzeitige Festschreibungen derselben Rechnung sähen beide `entwurf`.
   * Die Zusammenfassung macht das Vergessen unmöglich.
   */
  private async lockAndCheck(
    tx: Prisma.TransactionClient,
    id: string,
    allowed: InvoiceStatus[],
  ) {
    await lockInvoice(tx, id);
    const row = await tx.invoice.findUnique({
      where: { id },
      select: HEADER_FIELDS,
    });
    if (!row) throw new InvoiceNotFoundError();
    if (!allowed.includes(row.status)) {
      // Ein Entwurfsbefehl auf einer festgeschriebenen Rechnung ist der Fall,
      // vor dem R2 schützt — er bekommt seine eigene Meldung.
      if (allowed.length === 1 && allowed[0] === 'draft') {
        throw new InvoiceIsFinalizedError(row.invoiceNumber);
      }
      throw new InvoiceStatusMismatchError(row.status, allowed.join(' | '));
    }
    return row;
  }

  /** Rechnet den Entwurf durch und formt die Datenbankfelder. */
  private async draftData(
    companyId: string,
    dto: InvoiceDraftDto,
    paymentDueDays: number,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<{
    invoice: Omit<Prisma.InvoiceUncheckedCreateInput, 'companyId'>;
    lines: Omit<Prisma.InvoiceLineUncheckedCreateInput, 'invoiceId'>[];
    sumGrossCent: number;
  }> {
    const company = await db.company.findUnique({
      where: { id: companyId },
      select: {
        name: true,
        street: true,
        houseNumber: true,
        postalCode: true,
        city: true,
        country: true,
        billingName: true,
        billingStreet: true,
        billingHouseNumber: true,
        billingPostalCode: true,
        billingCity: true,
        billingCountry: true,
        billingEmail: true,
        contactEmail: true,
        buyerType: true,
        vatId: true,
        buyerReference: true,
        electronicAddress: true,
        electronicAddressScheme: true,
        // Für die Vorabankündigung auf dem Beleg.
        paymentMethod: true,
        sepaMandateReference: true,
      },
    });
    if (!company) throw new CompanyNotFoundError();

    // [W1] und [W6]: VOR jeder weiteren Rechnung mit dem Datum. Das
    // Rechnungsdatum steuert den Nummernkreis, und `datePlusDays` warf bei
    // einem Datum wie `9999-12-31` ungefangen — aus einer Fehleingabe wurde
    // ein `500 interner_fehler` statt einer Meldung, die den Fehler benennt.
    checkInvoiceDate(dto.invoiceDate, this.dateWindow());

    if (dto.servicePeriodUntil < dto.servicePeriodFrom) {
      throw new InvoiceIncompleteError([
        'Der Leistungszeitraum endet vor seinem Beginn.',
      ]);
    }

    // POSTENZEITRAUM: BEIDE ODER KEINER, und in dieser Reihenfolge.
    // Die Alternative waere gewesen, eine halbe Angabe stillschweigend
    // fallenzulassen — genau der Fehler, den `beschreibung` und `einheit`
    // hier jahrelang hatten. Eine verschluckte Eingabe faellt niemandem auf.
    const periodError: string[] = [];
    dto.lines.forEach((p, i) => {
      const half = (p.periodFrom === undefined) !== (p.periodUntil === undefined);
      if (half) {
        periodError.push(
          `Posten ${i + 1}: Bitte beide Daten des Zeitraums angeben oder beide weglassen.`,
        );
      } else if (
        p.periodFrom !== undefined &&
        p.periodUntil !== undefined &&
        p.periodUntil < p.periodFrom
      ) {
        periodError.push(
          `Posten ${i + 1}: Der Zeitraum endet vor seinem Beginn.`,
        );
      }
    });
    if (periodError.length > 0) {
      throw new InvoiceIncompleteError(periodError);
    }

    // STEUERKATEGORIE JE POSTEN: S/Z/E/AE/K/G/O mit Befreiungsgrund.
    const taxCheck = dto.lines.map((p, i) => {
      const category = p.taxCategory ?? 'S';
      const result = checkTaxCategory(
        i + 1,
        category,
        p.taxRate,
        p.taxExemptionReason,
      );
      return { category: category as TaxCategory, ...result };
    });
    const taxError = taxCheck.flatMap((c) => c.error);
    if (taxError.length > 0) throw new InvoiceIncompleteError(taxError);

    const inputs: LineInput[] = dto.lines.map((p, i) => ({
      label: p.label.trim(),
      ...(p.description ? { description: p.description.trim() } : {}),
      quantity: p.quantity,
      unitPriceNetCent: p.unitPriceNetCent,
      taxRate: p.taxRate,
      ...(p.unit ? { unit: p.unit } : {}),
      ...(taxCheck[i]?.category !== 'S' ? { taxCategory: taxCheck[i]!.category } : {}),
      ...(taxCheck[i]?.reason ? { taxExemptionReason: taxCheck[i]!.reason! } : {}),
      ...(p.periodFrom && p.periodUntil
        ? { period: { from: p.periodFrom, until: p.periodUntil } }
        : {}),
    }));
    const calculated = calculate(inputs);
    // Preisstufe je Posten: der Schlüssel muss in der Preisliste stehen (auch
    // archiviert — ein Entwurf darf eine ältere Stufe weiterführen); das
    // Etikett kommt aus der Preisliste, nicht vom Client.
    const tierOfLine = dto.lines.map((p) => {
      if (!p.priceTierKey) return { key: null, label: null };
      const tier = this.prices.tier(p.priceTierKey);
      if (tier === null) throw new PriceTierUnknownError(p.priceTierKey);
      return { key: tier.key, label: tier.label };
    });

    // [M16] Von Hand gesetzte Fälligkeit gilt, sonst Rechnungsdatum + Ziel.
    // Vor dem Rechnungsdatum ist sie nie sinnvoll (die Rechnung wäre mit
    // Ausstellung überfällig) und wird hier wie beim Festschreiben abgewiesen.
    const dueDateManual = dto.dueDate !== undefined;
    const due = dto.dueDate ?? datePlusDays(dto.invoiceDate, paymentDueDays);
    if (due < dto.invoiceDate) {
      throw new InvoiceIncompleteError([
        'Die Fälligkeit liegt vor dem Rechnungsdatum.',
      ]);
    }

    return {
      invoice: {
        invoiceDate: toDate(dto.invoiceDate),
        servicePeriodFrom: toDate(dto.servicePeriodFrom),
        servicePeriodUntil: toDate(dto.servicePeriodUntil),
        dueDate: toDate(due),
        dueDateManual,
        // Der Entwurf trägt den Schnappschuss bereits als VORSCHAU; die
        // Spalten sind nicht nullbar. Verbindlich wird er erst beim
        // Festschreiben, wo er frisch gelesen wird.
        ...recipientSnapshot(company),
        // DIE MANDATSREFERENZ NUR, WENN AUCH EINGEZOGEN WIRD. Sie steht an
        // der Organisation, auch wenn dort „Überweisung" eingetragen ist —
        // etwa nach einem Wechsel der Zahlungsart. Sie dann trotzdem auf den
        // Beleg zu schreiben hiesse, einen Einzug anzukündigen, der nicht
        // stattfindet.
        directDebitMandateReference: mandateReferenceFor(company),
        ...issuerSnapshot((await this.issuer.current()).issuer),
        // Zahlungsart nach UNTDID 4461: 59 = SEPA-Lastschrift (nur mit
        // Mandat), sonst 58 = SEPA-Überweisung. Währung: die der Preisliste
        // (Spaltenvorgabe EUR).
        paymentMeansCode: paymentMeansCodeFor(company),
        // Die drei Texte des Bearbeiten-Screens. `null` statt `undefined`,
        // damit ein geleertes Feld auch wirklich geleert wird — bei einem
        // Entwurf ist Loeschen eine gueltige Aenderung.
        introduction: dto.introduction?.trim() || null,
        paymentNote: dto.paymentNote?.trim() || null,
        internalNote: dto.internalNote?.trim() || null,
      },
      lines: calculated.lines.map((p, index) => ({
        // [M11] Eingabereihenfolge festhalten; ab 0.
        position: index,
        label: p.label,
        priceTierKey: tierOfLine[index]?.key ?? null,
        priceTierLabel: tierOfLine[index]?.label ?? null,
        // [H2]: WIRD JETZT GESPEICHERT. Vorher endete die Angabe hier und im
        // XML stand fest `C62` — auf einem unveränderlichen Beleg.
        unit: p.unit ?? null,
        // DERSELBE FEHLERTYP WIE [H2], derselbe Schluss: Beide Felder wurden
        // im DTO entgegengenommen, durch `LineInput` gereicht und beim
        // Schreiben verworfen. Jetzt landen sie in ihren Spalten.
        description: p.description ?? null,
        periodFrom: p.period ? toDate(p.period.from) : null,
        periodUntil: p.period ? toDate(p.period.until) : null,
        quantity: new Prisma.Decimal(p.quantity.toFixed(3)),
        unitPriceNet: centAsDecimal(p.unitPriceNetCent),
        taxRate: new Prisma.Decimal(p.taxRate.toFixed(2)),
        netAmount: centAsDecimal(p.netCent),
        taxAmount: centAsDecimal(p.taxCent),
        grossAmount: centAsDecimal(p.grossCent),
        taxCategory: p.taxCategory ?? 'S',
        taxExemptionReason: p.taxExemptionReason ?? null,
      })),
      sumGrossCent: calculated.sumGrossCent,
    };
  }
}

/** Zahlungsart nach UNTDID 4461: 59 nur mit Lastschrift UND Mandat, sonst 58. */
function paymentMeansCodeFor(company: {
  paymentMethod: string | null;
  sepaMandateReference: string | null;
}): '58' | '59' {
  return company.paymentMethod === 'direct_debit' &&
    (company.sepaMandateReference?.trim() || null) !== null
    ? '59'
    : '58';
}

/**
 * Die Mandatsreferenz nur, WENN AUCH EINGEZOGEN WIRD. Sie steht an der
 * Organisation, auch wenn dort „Überweisung" eingetragen ist — sie dann auf den
 * Beleg zu schreiben hieße, einen Einzug anzukündigen, der nicht stattfindet.
 */
function mandateReferenceFor(company: {
  paymentMethod: string | null;
  sepaMandateReference: string | null;
}): string | null {
  return company.paymentMethod === 'direct_debit'
    ? company.sepaMandateReference?.trim() || null
    : null;
}

/**
 * Ende der Aufbewahrungsfrist: 31.12. des Jahres der Festschreibung (nach
 * deutscher Zeit) plus `years` Jahre (Fachdatum, UTC-Mitternacht wie `@db.Date`).
 */
export function retentionEnd(finalizedAt: Date, years: number): Date {
  return new Date(Date.UTC(yearInBerlin(finalizedAt) + years, 11, 31));
}

/**
 * Das Kalenderjahr eines Zeitpunkts in Europe/Berlin [N8b].
 *
 * Mit dem UTC-Jahr rutschte ein Festschreiben in der Silvesternacht
 * (23:30 Uhr deutscher Zeit am 31.12. = 22:30 UTC, noch dasselbe Jahr, aber
 * 00:30 Uhr am 1.1. = 23:30 UTC des Vortags) ins falsche Jahr und verkürzte
 * die Aufbewahrungsfrist um ein Jahr. Maßgeblich ist der deutsche Kalender.
 */
export function yearInBerlin(at: Date): number {
  const year = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
  }).format(at);
  return Number(year);
}
