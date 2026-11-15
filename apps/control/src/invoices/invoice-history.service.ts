import { Injectable } from '@nestjs/common';
import { AUDIT_ACTION } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceNotFoundError } from './invoice.errors';

/**
 * Welche Audit-Aktionen im „Verlauf" einer Rechnung erscheinen.
 *
 * Bewusst eine feste Liste: Der Verlauf soll erzaehlen, was mit dem BELEG
 * geschah (erzeugt, festgeschrieben, Dokument erzeugt/abgerufen, versendet,
 * storniert, Zahlung, Uebertragung, Abweichung) — nicht jede technische Zeile.
 */
export const HISTORY_ACTIONS: readonly string[] = [
  AUDIT_ACTION.invoiceDraftCreated,
  AUDIT_ACTION.invoiceDraftUpdated,
  AUDIT_ACTION.invoiceFinalized,
  AUDIT_ACTION.invoiceDocumentGenerated,
  AUDIT_ACTION.invoiceDocumentInvalid,
  AUDIT_ACTION.invoiceDocumentDownloaded,
  AUDIT_ACTION.invoiceSent,
  AUDIT_ACTION.invoiceSendError,
  AUDIT_ACTION.invoicePaymentReminder,
  AUDIT_ACTION.invoiceCancelled,
  AUDIT_ACTION.invoicePaymentNoted,
  AUDIT_ACTION.invoiceTransferNoted,
  AUDIT_ACTION.invoiceIntegrityFailed,
];

const FORMATS = ['pdf', 'xml', 'xrechnung'];

/** Hoechstzahl Zeilen; ein Beleg mit tausenden Abrufen soll keine Antwort sprengen. */
export const HISTORY_LIMIT = 500;

/**
 * Eine Verlaufszeile. NUR Benutzername, Zeit (UTC) und Aktion — keine IP, kein
 * Browserkennzeichen, keine Vorher/Nachher-Werte. Beim Dokumentabruf zusaetzlich
 * das Format (`pdf`/`xml`/`xrechnung`), weil es Teil der Aussage ist.
 */
export interface HistoryEntry {
  /** UTC, ISO-8601. */
  at: string;
  actor: string;
  action: string;
  format?: string;
}

@Injectable()
export class InvoiceHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async history(id: string): Promise<HistoryEntry[]> {
    const exists = await this.prisma.invoice.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new InvoiceNotFoundError();

    const rows = await this.prisma.auditLog.findMany({
      where: {
        objectType: 'Invoice',
        objectId: id,
        action: { in: [...HISTORY_ACTIONS] },
      },
      // Neueste zuerst holen, damit bei Ueberschreitung der Grenze die alten
      // Zeilen wegfallen und nicht die jungen; danach chronologisch drehen.
      orderBy: { timestamp: 'desc' },
      take: HISTORY_LIMIT,
      select: { timestamp: true, actor: true, action: true, afterValue: true },
    });
    return rows.reverse().map((row) => {
      const entry: HistoryEntry = {
        at: row.timestamp.toISOString(),
        actor: row.actor,
        action: row.action,
      };
      const format =
        typeof row.afterValue === 'object' &&
        row.afterValue !== null &&
        !Array.isArray(row.afterValue)
          ? (row.afterValue as Record<string, unknown>)['format']
          : undefined;
      if (typeof format === 'string' && FORMATS.includes(format)) {
        entry.format = format;
      }
      return entry;
    });
  }
}
