import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DOCUMENT_COLUMNS, sha256Hex, type DocumentFormatKey } from './integrity';

/** Rechnungen je Seite. Die Dokumente sind gross; der Agent holt Seite für Seite. */
export const ARCHIVE_PAGE_SIZE = 25;

export interface ArchiveDocument {
  kind: DocumentFormatKey;
  base64: string;
  sha256: string;
}

export interface ArchiveItem {
  invoiceId: string;
  number: string;
  finalizedAt: string;
  retentionUntil: string | null;
  documents: ArchiveDocument[];
}

export interface InvoiceArchivePage {
  items: ArchiveItem[];
  /** Cursor für die nächste Seite (`?after=`); `null` am Ende. */
  next: string | null;
}

/**
 * Das Rechnungsarchiv für den Sicherungs-Agent.
 *
 * Die Dokumentspalten sind in der Datenbank verschlüsselt; der erweiterte
 * Client entschlüsselt beim Lesen. Der Agent bekommt Klartext plus die
 * SHA-256 (die beim Festschreiben über den Klartext gebildete, sonst die
 * errechnete) und prüft sie selbst, bevor etwas ins unveränderliche Archiv geht.
 *
 * Inkrementell über einen Cursor (die Rechnungs-id, stabil und unveränderlich).
 * Bei gesperrtem Tresor kommt es nie so weit: die Sperre (423) greift vorher.
 */
@Injectable()
export class InvoiceArchiveService {
  constructor(private readonly prisma: PrismaService) {}

  async page(after: string | undefined): Promise<InvoiceArchivePage> {
    const rows = await this.prisma.invoice.findMany({
      where: { finalizedAt: { not: null }, invoiceNumber: { not: null } },
      orderBy: { id: 'asc' },
      take: ARCHIVE_PAGE_SIZE,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
      select: {
        id: true,
        invoiceNumber: true,
        finalizedAt: true,
        retentionUntil: true,
        pdfContent: true,
        xmlContent: true,
        xrechnungContent: true,
        pdfSha256: true,
        xmlSha256: true,
        xrechnungSha256: true,
      },
    });

    const items = rows.map((row): ArchiveItem => {
      const documents: ArchiveDocument[] = [];
      for (const c of DOCUMENT_COLUMNS) {
        const content = row[c.content];
        if (content === null) continue;
        documents.push({
          kind: c.format,
          base64: Buffer.from(content).toString('base64'),
          sha256: row[c.hash]?.toLowerCase() ?? sha256Hex(content),
        });
      }
      return {
        invoiceId: row.id,
        number: row.invoiceNumber as string,
        finalizedAt: (row.finalizedAt as Date).toISOString(),
        retentionUntil: row.retentionUntil?.toISOString().slice(0, 10) ?? null,
        documents,
      };
    });

    const last = rows[rows.length - 1];
    return {
      items,
      next: rows.length === ARCHIVE_PAGE_SIZE && last ? last.id : null,
    };
  }
}
