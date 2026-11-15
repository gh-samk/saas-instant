import { Injectable, Logger } from '@nestjs/common';
import { dateStringFromDate } from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import type { InquirySource } from '../common/inquiry-source';
import { dayReadable } from '../common/calendar';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceDocumentService } from './document.service';
import { getInvoice } from './invoice.query';
import { decimalAsCent } from './invoice.amount';
import {
  InvoiceNotFoundError,
  InvoiceWithoutRecipientAddressError,
  InvoiceStatusMismatchError,
} from './invoice.errors';
import type { InvoiceResponse } from './invoice.response';
import type { Actor } from './invoice.service';
import { InvoiceService } from './invoice.service';

/**
 * DER VERSAND — über den bestehenden `MailService`, als Transaktionsmail.
 *
 * Transaktion und nicht werblich: Eine Rechnung ist die Erfüllung eines
 * Vertrages, keine Ansprache. Sie braucht keine Einwilligung, und eine
 * Abmeldung vom Newsletter darf sie nicht verhindern — deshalb wird die
 * Einwilligungstabelle hier bewusst nicht gefragt.
 *
 * DREI SCHRITTE, IN DIESER REIHENFOLGE:
 * 1. Dokument holen oder erzeugen. Scheitert das, geht nichts hinaus — eine
 *    Rechnungsmail ohne Rechnung wäre schlimmer als keine Mail.
 * 2. Verschicken.
 * 3. ERST DANN vermerken (`MailVersand`-Zeile, Status `versendet`,
 *    Audit-Eintrag).
 *
 * Die Reihenfolge ist der ganze Punkt: Wer zuerst „versendet" schreibt und
 * dann verschickt, hat nach dem ersten SMTP-Ausfall eine Rechnung, die
 * niemand bekommen hat und die trotzdem als zugestellt gilt.
 */
@Injectable()
export class InvoiceSendService {
  private readonly logger = new Logger(InvoiceSendService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly documents: InvoiceDocumentService,
    private readonly invoices: InvoiceService,
  ) {}

  /** Schickt die Rechnung an die Empfängeradresse des Schnappschusses. */
  async send(
    id: string,
    actor: Actor,
    source: InquirySource,
  ): Promise<InvoiceResponse> {
    const invoice = await this.loadSendable(id);
    const document = await this.documents.getOrCreate(id, actor, source);

    const subject = `Rechnung ${invoice.invoiceNumber} – ${invoice.issuerCompanyName}`;
    const text = this.invoiceText(invoice);

    try {
      await this.mail.sendInvoice(invoice.recipientEmail, subject, text, {
        filename: document.filename,
        content: document.pdf,
      });
    } catch (exception) {
      await this.audit.log({
        userId: actor.userId,
        actor: actor.name,
        action: AUDIT_ACTION.invoiceSendError,
        objectType: 'Invoice',
        objectId: id,
        afterValue: { invoiceNumber: invoice.invoiceNumber },
        ...source,
      });
      throw exception;
    }

    await this.prisma.mailDelivery.create({
      data: {
        companyId: invoice.companyId,
        recipientAddress: invoice.recipientEmail,
        channel: 'transactional',
        subject,
        // Der WORTLAUT der versendeten Mail als Nachweis — ohne den Anhang.
        // Das PDF liegt bereits an der Rechnung; es hier ein zweites Mal
        // abzulegen verdoppelte den Platz ohne Erkenntnisgewinn.
        contentSnapshot: text,
        sentAt: new Date(),
        deliveryStatus: 'sent',
      },
    });

    await this.invoices.sendNote(id);
    await this.audit.log({
      userId: actor.userId,
      actor: actor.name,
      action: AUDIT_ACTION.invoiceSent,
      objectType: 'Invoice',
      objectId: id,
      afterValue: { invoiceNumber: invoice.invoiceNumber },
      ...source,
    });

    this.logger.log(`Rechnung ${invoice.invoiceNumber} versendet.`);
    return getInvoice(this.prisma, id);
  }

  /**
   * Schickt eine Zahlungserinnerung.
   *
   * KEINE MAHNUNG. Kein Verzugszins, keine Mahngebühr, keine Fristsetzung —
   * das wäre ein rechtsgeschäftlicher Vorgang mit eigenen Formerfordernissen,
   * und der Auftrag verlangt eine Erinnerung. Sie wird von Hand ausgelöst;
   * die Fälligkeit meldet sich als Dashboard-Aufgabe.
   */
  async remind(
    id: string,
    actor: Actor,
    source: InquirySource,
  ): Promise<InvoiceResponse> {
    const invoice = await this.loadSendable(id);
    if (invoice.status === 'paid' || invoice.status === 'cancelled') {
      throw new InvoiceStatusMismatchError(invoice.status, 'open');
    }

    const subject = `Zahlungserinnerung zu Rechnung ${invoice.invoiceNumber}`;
    const text = this.reminderText(invoice);

    // Der Anhang ist freiwillig: Liegt kein Dokument vor und lässt es sich
    // gerade nicht erzeugen, geht die Erinnerung trotzdem hinaus. Eine
    // Erinnerung ohne Anhang ist immer noch eine Erinnerung.
    let attachment: { filename: string; content: Buffer } | undefined;
    try {
      const document = await this.documents.getOrCreate(id, actor, source);
      attachment = { filename: document.filename, content: document.pdf };
    } catch (exception) {
      this.logger.warn(
        `Zahlungserinnerung zu ${invoice.invoiceNumber} geht ohne Anhang ` +
          `hinaus: ${exception instanceof Error ? exception.message : exception}`,
      );
    }

    await this.mail.sendPaymentReminder(
      invoice.recipientEmail,
      subject,
      text,
      attachment,
    );

    await this.prisma.mailDelivery.create({
      data: {
        companyId: invoice.companyId,
        recipientAddress: invoice.recipientEmail,
        channel: 'transactional',
        subject,
        contentSnapshot: text,
        sentAt: new Date(),
        deliveryStatus: 'sent',
      },
    });

    await this.audit.log({
      userId: actor.userId,
      actor: actor.name,
      action: AUDIT_ACTION.invoicePaymentReminder,
      objectType: 'Invoice',
      objectId: id,
      afterValue: {
        invoiceNumber: invoice.invoiceNumber,
        withAttachment: attachment !== undefined,
      },
      ...source,
    });

    return getInvoice(this.prisma, id);
  }

  // ----------------------------------------------------------------- intern

  /** Lädt die Rechnung und stellt sicher, dass sie versendbar ist. */
  private async loadSendable(id: string): Promise<{
    companyId: string;
    invoiceNumber: string;
    status: string;
    recipientEmail: string;
    recipientName: string;
    issuerCompanyName: string;
    issuerBankDetails: string | null;
    dueDate: string;
    sumGrossCent: number;
  }> {
    const row = await this.prisma.invoice.findUnique({
      where: { id },
      select: {
        companyId: true,
        invoiceNumber: true,
        status: true,
        recipientEmail: true,
        recipientName: true,
        issuerCompanyName: true,
        issuerBankDetails: true,
        dueDate: true,
        lines: { select: { grossAmount: true } },
      },
    });
    if (!row) throw new InvoiceNotFoundError();
    if (row.status === 'draft' || row.invoiceNumber === null) {
      // Ein Entwurf hat keine Nummer und war nie ein Beleg.
      throw new InvoiceStatusMismatchError(row.status, 'finalized');
    }
    if (!row.recipientEmail) throw new InvoiceWithoutRecipientAddressError();

    return {
      companyId: row.companyId,
      invoiceNumber: row.invoiceNumber,
      status: row.status,
      recipientEmail: row.recipientEmail,
      recipientName: row.recipientName,
      issuerCompanyName: row.issuerCompanyName,
      issuerBankDetails: row.issuerBankDetails,
      dueDate: dateStringFromDate(row.dueDate),
      sumGrossCent: row.lines.reduce(
        (s, p) => s + (decimalAsCent(p.grossAmount) ?? 0),
        0,
      ),
    };
  }

  private amountReadable(cent: number): string {
    return `${(cent / 100).toLocaleString('de-DE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} €`;
  }

  private invoiceText(r: {
    recipientName: string;
    invoiceNumber: string;
    sumGrossCent: number;
    dueDate: string;
    issuerCompanyName: string;
  }): string {
    return (
      `Guten Tag,\n\n` +
      `anbei die Rechnung ${r.invoiceNumber} über ` +
      `${this.amountReadable(r.sumGrossCent)} für ${r.recipientName}.\n\n` +
      `Zahlbar ohne Abzug bis zum ${dayReadable(r.dueDate)}.\n\n` +
      `Die Rechnung liegt als PDF bei. Sie enthält zusätzlich eine ` +
      `maschinenlesbare Fassung nach ZUGFeRD (factur-x.xml) — falls eure ` +
      `Buchhaltung damit arbeitet, lässt sie sich direkt einlesen.\n\n` +
      `Bei Fragen einfach auf diese Mail antworten.\n\n` +
      `Freundliche Grüße\n${r.issuerCompanyName}\n`
    );
  }

  private reminderText(r: {
    recipientName: string;
    invoiceNumber: string;
    sumGrossCent: number;
    dueDate: string;
    issuerCompanyName: string;
  }): string {
    return (
      `Guten Tag,\n\n` +
      `die Rechnung ${r.invoiceNumber} über ` +
      `${this.amountReadable(r.sumGrossCent)} war am ` +
      `${dayReadable(r.dueDate)} fällig und ist bei uns noch nicht ` +
      `als bezahlt vermerkt.\n\n` +
      `Falls die Zahlung inzwischen unterwegs ist, betrachtet diese Nachricht ` +
      `bitte als gegenstandslos — wir gleichen von Hand ab, da kann sich ` +
      `etwas überschneiden.\n\n` +
      `Falls etwas unklar ist oder es gerade nicht passt: Meldet euch, wir ` +
      `finden eine Lösung.\n\n` +
      `Freundliche Grüße\n${r.issuerCompanyName}\n`
    );
  }
}
