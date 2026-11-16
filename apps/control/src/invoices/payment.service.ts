import { Injectable } from '@nestjs/common';
import type { InvoiceStatus } from '.prisma/control-client';
import { dateStringFromDate, today, toDate } from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import type { InquirySource } from '../common/inquiry-source';
import { PrismaService } from '../prisma/prisma.service';
import { getInvoice, lockInvoice } from './invoice.query';
import { centAsDecimal, decimalAsCent } from './invoice.amount';
import {
  InvoiceNotFoundError,
  InvoiceStatusMismatchError,
  PaymentChangedMeanwhileError,
  PaymentImplausibleError,
} from './invoice.errors';
import type { Actor } from './invoice.service';
import type { InvoiceResponse } from './invoice.response';

/** Zustände, in denen eine Zahlung vermerkt werden darf. */
const PAYABLE: InvoiceStatus[] = [
  'finalized',
  'sent',
  'overdue',
  'paid',
  'partially_paid',
];

/**
 * ZAHLUNGEN — VOLLSTÄNDIG VON HAND.
 *
 * Es gibt in diesem System keinen Kontoabgleich, keine Bankschnittstelle und
 * kein SEPA-XML. Das ist keine Lücke, sondern der Auftrag: Die Betreiberin
 * sieht auf den Kontoauszug und trägt ein, was sie dort findet.
 *
 * DIESER DIENST FASST GENAU DREI SPALTEN AN: `zahldatum`, `paidAmount`
 * und `status`. Keine Beträge, keine Posten, keinen Schnappschuss, keine
 * Nummer. R2 bleibt damit unberührt — der Zahlungsstand ist eine Aussage über
 * das Konto, nicht über den Beleg.
 *
 * Die Statusspalte wird mitgeführt, weil sie in der Init-Migration existiert
 * und Filter darauf laufen. Maßgeblich für die Anzeige ist trotzdem der
 * ABGELEITETE `zahlungsstand` (siehe `invoice.response.ts`): Nur er kann
 * „überfällig" sagen, ohne dass jemand nachts Rechnungen anfasst.
 */
@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Vermerkt eine Zahlung.
   *
   * `paidAmountCent` ist der KUMULIERTE Stand, nicht die einzelne
   * Überweisung. Zwei Teilzahlungen ergeben zwei Aufrufe mit steigendem
   * Betrag. Der Grund: Ein Modell mit Einzelbuchungen bräuchte eine eigene
   * Tabelle und einen Weg, eine falsch erfasste Buchung zurückzunehmen — also
   * einen Löschpfad an einem Beleg. Ein kumulierter Stand lässt sich
   * berichtigen, indem man ihn richtig hinschreibt (auch auf 0 zurück), und
   * jede Berichtigung steht im Audit-Log.
   *
   * [N8e] `expectedPaidCent` ist der Stand, von dem die Oberfläche ausging.
   * Ist inzwischen etwas anderes gespeichert (zweiter Tab, zweite Person),
   * wird nichts überschrieben, sondern mit 409 geantwortet: sonst gewänne
   * stillschweigend der Letzte, und eine Teilzahlung ginge verloren. Ohne
   * Angabe (direkter Dienstaufruf) wird nicht geprüft; die Route verlangt sie.
   */
  async note(
    id: string,
    paymentDate: string,
    paidAmountCent: number,
    actor: Actor,
    source: InquirySource,
    expectedPaidCent?: number,
  ): Promise<InvoiceResponse> {
    await this.prisma.$transaction(async (tx) => {
      await lockInvoice(tx, id);
      const invoice = await tx.invoice.findUnique({
        where: { id },
        select: {
          status: true,
          invoiceNumber: true,
          invoiceDate: true,
          paymentDate: true,
          paidAmount: true,
          lines: { select: { grossAmount: true } },
        },
      });
      if (!invoice) throw new InvoiceNotFoundError();
      const currentPaidCent = decimalAsCent(invoice.paidAmount) ?? 0;
      if (expectedPaidCent !== undefined && expectedPaidCent !== currentPaidCent) {
        throw new PaymentChangedMeanwhileError(currentPaidCent);
      }
      if (!PAYABLE.includes(invoice.status)) {
        // Ein Entwurf ist nie hinausgegangen, eine Stornorechnung hebt auf.
        // Bei beiden wäre ein Zahlungseingang ein Hinweis auf eine
        // Verwechslung — und den soll die Betreiberin sehen, nicht wegklicken.
        throw new InvoiceStatusMismatchError(
          invoice.status,
          PAYABLE.join(' | '),
        );
      }

      const sumGrossCent = invoice.lines.reduce(
        (s, p) => s + (decimalAsCent(p.grossAmount) ?? 0),
        0,
      );
      // Eine Zahlung, die den Rechnungsbetrag um mehr als einen Euro
      // übersteigt, ist fast immer ein Zahlendreher. Ein Euro Spielraum, weil
      // Kundinnen gelegentlich aufrunden.
      if (
        sumGrossCent >= 0 &&
        paidAmountCent > sumGrossCent + 100
      ) {
        throw new PaymentImplausibleError(
          'Der gezahlte Betrag liegt deutlich über dem Rechnungsbetrag. ' +
            'Prüfe die Eingabe.',
          { sumGrossCent, paidAmountCent },
        );
      }
      if (paidAmountCent < 0 && sumGrossCent >= 0) {
        throw new PaymentImplausibleError(
          'Ein negativer Zahlbetrag passt nicht zu einer positiven Rechnung.',
        );
      }
      if (paymentDate < dateStringFromDate(invoice.invoiceDate)) {
        throw new PaymentImplausibleError(
          'Das Zahldatum liegt vor dem Rechnungsdatum.',
          {
            invoiceDate: dateStringFromDate(invoice.invoiceDate),
            paymentDate,
          },
        );
      }
      if (paymentDate > today()) {
        throw new PaymentImplausibleError('Das Zahldatum liegt in der Zukunft.');
      }

      // [N8a] Eine Rechnung über 0 € ist ausgeglichen (nichts zu zahlen) und
      // nie „offen": sonst bliebe sie ewig unbezahlt und würde überfällig.
      const complete =
        sumGrossCent === 0
          ? true
          : sumGrossCent > 0
            ? paidAmountCent >= sumGrossCent
            : paidAmountCent <= sumGrossCent;
      /**
       * NUR ZWEI ZUSTAENDE: bezahlt oder nicht.
       *
       * Entscheidung des Auftraggebers beim Durchgang zum Redesign, woertlich:
       * „Ich muss Zahlungen ja manuell erfassen — es wird kein echtes Konto
       * gegengeprueft. Daher gibt es nur Offen oder Gezahlt. Wer weniger
       * zahlt, mit dem muss ich sowieso korrespondieren, aber das trage ich
       * nicht ins System ein."
       *
       * Eine Teilzahlung wird deshalb FESTGEHALTEN (`paidAmount`,
       * `zahldatum` bleiben stehen und stehen in der Ansicht), aendert aber
       * den Zustand nicht — die Rechnung bleibt festgeschrieben und damit
       * abgeleitet „offen" beziehungsweise „ueberfaellig".
       *
       * WARUM DAS HIER UND NICHT NUR IN DER ABLEITUNG STEHT: Stuende die
       * Spalte weiter auf `teilweise_bezahlt`, waehrend `zahlungsstand`
       * „offen" sagt, widersprechen sich zwei Felder ueber denselben
       * Sachverhalt. Das faellt niemandem auf, bis es jemandem auffaellt.
       *
       * [M14] „NICHT BEZAHLT" HEISST NICHT „FESTGESCHRIEBEN": Eine versendete
       * Rechnung blieb nach einer Teilzahlung nicht `sent`, sondern fiel auf
       * `finalized` zurück und sah aus, als wäre sie nie hinausgegangen. Der
       * bisherige Zustand bleibt deshalb erhalten. Nur aus `paid` (Berichtigung
       * eines zu hoch erfassten Standes) geht es zurück — auf `sent`, wenn die
       * Rechnung nachweislich versendet wurde (Audit-Eintrag des Versands),
       * sonst auf `finalized`.
       */
      let newStatus: InvoiceStatus;
      if (complete) {
        newStatus = 'paid';
      } else if (invoice.status === 'paid') {
        const wasSent = await tx.auditLog.findFirst({
          where: {
            action: AUDIT_ACTION.invoiceSent,
            objectType: 'Invoice',
            objectId: id,
          },
          select: { id: true },
        });
        newStatus = wasSent ? 'sent' : 'finalized';
      } else {
        newStatus = invoice.status;
      }

      await tx.invoice.update({
        where: { id },
        data: {
          paymentDate: paidAmountCent === 0 ? null : toDate(paymentDate),
          paidAmount:
            paidAmountCent === 0 ? null : centAsDecimal(paidAmountCent),
          status: newStatus,
        },
      });

      await this.audit.log(
        {
          userId: actor.userId,
          actor: actor.name,
          action: AUDIT_ACTION.invoicePaymentNoted,
          objectType: 'Invoice',
          objectId: id,
          // BETRÄGE, KEINE ZAHLUNGSDATEN. Es steht hier weder eine IBAN noch
          // ein Verwendungszweck noch ein Kontoauszug — die Sperrliste aus
          // Etappe 2 verlangt das, und der Nachweis braucht es nicht.
          beforeValue: {
            status: invoice.status,
            paidAmountCent: decimalAsCent(invoice.paidAmount),
            paymentDate:
              invoice.paymentDate === null
                ? null
                : dateStringFromDate(invoice.paymentDate),
          },
          afterValue: {
            status: newStatus,
            paidAmountCent,
            paymentDate: paidAmountCent === 0 ? null : paymentDate,
            sumGrossCent,
            // [M13] Berichtigung eines schon erfassten Standes (auch auf 0)
            // — im Nachweis erkennbar von einer weiteren Zahlung zu trennen.
            correction:
              currentPaidCent !== 0 && paidAmountCent < currentPaidCent,
          },
          ...source,
        },
        tx,
      );
    });

    return this.get(id);
  }

  /**
   * Setzt den Übertragungsvermerk an die Buchhaltung.
   *
   * AUSDRÜCKLICH OHNE SCHNITTSTELLE. Es gibt keine lexoffice- und keine
   * sevDesk-API in diesem System; der Auftraggeber überträgt die Belege von
   * Hand. Dieses Feld hält fest, was er getan hat — mehr nicht.
   */
  async noteTransfer(
    id: string,
    transferStatus: string,
    actor: Actor,
    source: InquirySource,
  ): Promise<InvoiceResponse> {
    const value = transferStatus.trim();
    // [N8c] Änderung und Audit-Eintrag in EINER Transaktion: Scheitert der
    // Nachweis, bleibt auch der Vermerk ungesetzt — kein Vermerk ohne Spur.
    await this.prisma.$transaction(async (tx) => {
      await lockInvoice(tx, id);
      const row = await tx.invoice.findUnique({
        where: { id },
        select: { transferStatus: true, status: true },
      });
      if (!row) throw new InvoiceNotFoundError();
      if (row.status === 'draft') {
        throw new InvoiceStatusMismatchError('draft', 'finalized');
      }

      await tx.invoice.update({
        where: { id },
        data: { transferStatus: value },
      });
      await this.audit.log(
        {
          userId: actor.userId,
          actor: actor.name,
          action: AUDIT_ACTION.invoiceTransferNoted,
          objectType: 'Invoice',
          objectId: id,
          beforeValue: { transferStatus: row.transferStatus },
          afterValue: { transferStatus: value },
          ...source,
        },
        tx,
      );
    });
    return this.get(id);
  }

  /**
   * Holt die Rechnung über denselben Leseweg wie der `InvoiceService`.
   *
   * Bewusst über die gemeinsame Abfrageschicht und nicht über eine Injektion
   * des `InvoiceService`: Die beiden Dienste sind absichtlich getrennt (R2),
   * und eine gegenseitige Abhängigkeit machte aus zwei Zuständigkeiten wieder
   * eine.
   */
  private async get(id: string): Promise<InvoiceResponse> {
    return getInvoice(this.prisma, id);
  }
}
