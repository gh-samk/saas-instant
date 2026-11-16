import { Injectable, Logger } from '@nestjs/common';
import { FieldDecryptError } from '../crypto/field-crypto';
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

/** Eine Rechnung, die in dieser Seite NICHT geliefert werden konnte. */
export interface ArchiveSkipped {
  invoiceId: string;
  number: string | null;
  /** Nur `undecryptable`: der Chiffretext liess sich nicht entschluesseln (veraendert oder falscher Schluessel). */
  reason: 'undecryptable';
  /** Betroffene Spalten, z. B. `pdfContent`. */
  fields: string[];
}

export interface InvoiceArchivePage {
  items: ArchiveItem[];
  /**
   * Uebersprungene Rechnungen. Der Agent muss sie melden und darf die Seite nicht
   * als vollstaendig verbuchen: ein Beleg, der nicht ins unveraenderliche Archiv
   * kommt, ist ein Befund (siehe Integritaetslauf, Aufgabe "Beleg manipuliert").
   */
  skipped: ArchiveSkipped[];
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
const ARCHIVE_SELECT = {
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
} as const;

@Injectable()
export class InvoiceArchiveService {
  private readonly logger = new Logger(InvoiceArchiveService.name);

  constructor(private readonly prisma: PrismaService) {}

  async page(after: string | undefined): Promise<InvoiceArchivePage> {
    const paging = {
      where: { finalizedAt: { not: null }, invoiceNumber: { not: null } },
      orderBy: { id: 'asc' as const },
      take: ARCHIVE_PAGE_SIZE,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    };

    type Row = Awaited<
      ReturnType<typeof this.prisma.invoice.findMany<{ select: typeof ARCHIVE_SELECT }>>
    >[number];
    const rows: Row[] = [];
    const skipped: ArchiveSkipped[] = [];
    let lastId: string | undefined;
    let count: number;

    try {
      const fetched = await this.prisma.invoice.findMany({ ...paging, select: ARCHIVE_SELECT });
      rows.push(...fetched);
      count = fetched.length;
      lastId = fetched[fetched.length - 1]?.id;
    } catch (error) {
      if (!(error instanceof FieldDecryptError)) throw error;
      // Eine Rechnung dieser Seite ist unlesbar (Chiffretext veraendert): Zeile
      // fuer Zeile lesen, die lesbaren liefern, die anderen melden.
      const metas = await this.prisma.invoice.findMany({
        ...paging,
        select: { id: true, invoiceNumber: true },
      });
      count = metas.length;
      lastId = metas[metas.length - 1]?.id;
      for (const meta of metas) {
        try {
          const row = await this.prisma.invoice.findUnique({
            where: { id: meta.id },
            select: ARCHIVE_SELECT,
          });
          if (row) rows.push(row);
        } catch (rowError) {
          if (!(rowError instanceof FieldDecryptError)) throw rowError;
          this.logger.error(
            `Archiv: Rechnung ${meta.invoiceNumber ?? meta.id} uebersprungen, ` +
              `${rowError.field} nicht entschluesselbar.`,
          );
          skipped.push({
            invoiceId: meta.id,
            number: meta.invoiceNumber,
            reason: 'undecryptable',
            fields: [rowError.field],
          });
        }
      }
    }

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

    return {
      items,
      skipped,
      next: count === ARCHIVE_PAGE_SIZE && lastId ? lastId : null,
    };
  }
}
