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
   * berichtigen, indem man ihn richtig hinschreibt, und jede Berichtigung
   * steht im Audit-Log.
   */
  async note(
    id: string,
    paymentDate: string,
    paidAmountCent: number,
    actor: Actor,
    source: InquirySource,
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

      const complete =
        sumGrossCent >= 0
          ? paidAmountCent >= sumGrossCent && sumGrossCent !== 0
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
       */
      const newStatus: InvoiceStatus = complete
        ? 'paid'
        : 'finalized';

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
    const row = await this.prisma.invoice.findUnique({
      where: { id },
      select: { transferStatus: true, status: true },
    });
    if (!row) throw new InvoiceNotFoundError();
    if (row.status === 'draft') {
      throw new InvoiceStatusMismatchError('draft', 'finalized');
    }

    await this.prisma.invoice.update({
      where: { id },
      data: { transferStatus: transferStatus.trim() },
    });
    await this.audit.log({
      userId: actor.userId,
      actor: actor.name,
      action: AUDIT_ACTION.invoiceTransferNoted,
      objectType: 'Invoice',
      objectId: id,
      beforeValue: { transferStatus: row.transferStatus },
      afterValue: { transferStatus: transferStatus.trim() },
      ...source,
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
