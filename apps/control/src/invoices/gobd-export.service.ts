import { HttpStatus, Injectable } from '@nestjs/common';
import { dateStringFromDate, toDate } from '@saas-instant/shared';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import type { InquirySource } from '../common/inquiry-source';
import { BusinessError } from '../common/errors/business-error';
import { PrismaService } from '../prisma/prisma.service';
import { centAsXml, decimalAsCent } from './invoice.amount';
import type { Actor } from './invoice.service';
import { DOCUMENT_COLUMNS, checkDocument, isFailure, sha256Hex } from './integrity';

/** Hoechstzahl Rechnungen je Export. Groessere Zeitraeume werden aufgeteilt. */
export const GOBD_EXPORT_MAX_INVOICES = 10_000;

/** Wie viele Rechnungen auf einmal aus der Datenbank geholt werden. */
const PAGE_SIZE = 50;

export class GobdExportRangeError extends BusinessError {
  constructor() {
    super(
      'gobd_export_range_invalid',
      'Der Zeitraum ist ungültig: „von" darf nicht nach „bis" liegen.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

export class GobdExportTooLargeError extends BusinessError {
  constructor(count: number) {
    super(
      'gobd_export_too_large',
      `Der Zeitraum enthält ${count} Rechnungen; je Export sind höchstens ` +
        `${GOBD_EXPORT_MAX_INVOICES} möglich. Bitte den Zeitraum aufteilen.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
      { count, max: GOBD_EXPORT_MAX_INVOICES },
    );
  }
}

/** Spaltenreihenfolge von `index.csv`. */
export const INDEX_COLUMNS = [
  'Nummer',
  'Datum',
  'Empfaenger',
  'Netto',
  'Steuer',
  'Brutto',
  'Waehrung',
  'Status',
  'PdfSha256',
  'XmlSha256',
  'XRechnungSha256',
  'AufbewahrungBis',
  'Integritaet',
] as const;

export interface IndexRow {
  number: string;
  date: string;
  recipient: string;
  netCent: number;
  taxCent: number;
  grossCent: number;
  currency: string;
  status: string;
  pdfSha256: string | null;
  xmlSha256: string | null;
  xrechnungSha256: string | null;
  retentionUntil: string | null;
  /** `ok` oder `abweichung` (gespeicherte Pruefsumme passt nicht zu den Bytes). */
  integrity: 'ok' | 'abweichung';
}

/**
 * Eine CSV-Zelle: immer in Anfuehrungszeichen, `"` verdoppelt. Beginnt ein Text
 * mit `=`, `+`, `-`, `@`, Tab oder CR, setzt `text: true` ein `'` davor, damit
 * Tabellenprogramme ihn nicht als Formel auswerten (CSV-Injection).
 */
export function csvCell(value: string, text = true): string {
  let v = value.replace(/\r?\n/g, ' ');
  if (text && /^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return `"${v.replace(/"/g, '""')}"`;
}

/**
 * `index.csv`: UTF-8 mit BOM, Trenner `;`, Zeilenende CRLF, Dezimalpunkt,
 * Betraege in Euro (bzw. Rechnungswaehrung) mit zwei Nachkommastellen.
 */
export function buildIndexCsv(rows: readonly IndexRow[]): string {
  const lines = [INDEX_COLUMNS.map((c) => csvCell(c, false)).join(';')];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.number),
        csvCell(r.date, false),
        csvCell(r.recipient),
        csvCell(centAsXml(r.netCent), false),
        csvCell(centAsXml(r.taxCent), false),
        csvCell(centAsXml(r.grossCent), false),
        csvCell(r.currency, false),
        csvCell(r.status, false),
        csvCell(r.pdfSha256 ?? '', false),
        csvCell(r.xmlSha256 ?? '', false),
        csvCell(r.xrechnungSha256 ?? '', false),
        csvCell(r.retentionUntil ?? '', false),
        csvCell(r.integrity, false),
      ].join(';'),
    );
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

/**
 * `hashes.sha256` im Format von `sha256sum`: `<64 Hex>␣␣<Pfad>` (Textmodus),
 * ein Eintrag je Zeile, Pfade relativ zur Wurzel des Archivs. Prueffbar mit
 * `sha256sum -c hashes.sha256`.
 */
export function buildHashFile(
  entries: readonly { path: string; sha256: string }[],
): string {
  return entries.map((e) => `${e.sha256}  ${e.path}\n`).join('');
}

export function buildReadme(range: { from: string; to: string }, count: number): string {
  return `GoBD-Export (technischer Export fuer die Betriebspruefung)
====================================================================

Zeitraum (Rechnungsdatum): ${range.from} bis ${range.to}
Anzahl Rechnungen:         ${count}

Inhalt
------
  invoices/<Jahr>/<Nummer>.pdf             Rechnung als ZUGFeRD/Factur-X-PDF (PDF/A-3b)
  invoices/<Jahr>/<Nummer>.xml             strukturierter Teil (CII, EN 16931)
  invoices/<Jahr>/<Nummer>-xrechnung.xml   XRechnung, falls erzeugt
  index.csv                                Verzeichnis aller Rechnungen
  index-description.json                   maschinenlesbare Beschreibung von index.csv
  hashes.sha256                            SHA-256-Pruefsummen aller Dateien
  README.txt                               diese Datei

Die Dokumente sind unveraendert so enthalten, wie sie beim Erzeugen gespeichert
wurden. Sie werden nie neu erzeugt.

Verifikation
------------
Archiv entpacken und im Wurzelverzeichnis ausfuehren:

  sha256sum -c hashes.sha256        (Linux)
  shasum -a 256 -c hashes.sha256    (macOS)

Jede Zeile muss mit "OK" enden. Die Spalten PdfSha256, XmlSha256 und
XRechnungSha256 in index.csv enthalten die beim Erzeugen der Rechnung
gespeicherten Pruefsummen; sie muessen mit den Werten in hashes.sha256 fuer
die jeweilige Datei uebereinstimmen. Die Spalte Integritaet steht auf
"abweichung", wenn die gespeicherte Pruefsumme nicht zu den Daten passt.

Format von index.csv
--------------------
UTF-8 mit BOM, Trennzeichen Semikolon, Zeilenende CRLF, Texte in
Anfuehrungszeichen, Dezimalpunkt, Betraege mit zwei Nachkommastellen in der
Rechnungswaehrung, Datumsangaben JJJJ-MM-TT. Textzellen, die mit = + - @
beginnen, tragen ein vorangestelltes Hochkomma (Schutz vor Formelauswertung).

Hinweis
-------
Technischer Export, keine Rechtsberatung. Er ersetzt weder eine
Verfahrensdokumentation noch eine steuerliche Beratung. Bitte stimmen Sie die
Aufbewahrung und die Herausgabe an Pruefer mit Ihrer Steuerberatung ab.
`;
}

/** Maschinenlesbare Beschreibung von `index.csv`. */
export function buildIndexDescription(): string {
  const text = (name: string, description: string) => ({
    name,
    type: 'string',
    description,
  });
  return `${JSON.stringify(
    {
      file: 'index.csv',
      encoding: 'UTF-8 (BOM)',
      delimiter: ';',
      recordDelimiter: 'CRLF',
      quote: '"',
      decimalSeparator: '.',
      dateFormat: 'YYYY-MM-DD',
      columns: [
        text('Nummer', 'Rechnungsnummer JJJJ-NNN'),
        { name: 'Datum', type: 'date', description: 'Rechnungsdatum' },
        text('Empfaenger', 'Name des Rechnungsempfaengers laut Beleg'),
        { name: 'Netto', type: 'decimal(10,2)', description: 'Summe netto' },
        { name: 'Steuer', type: 'decimal(10,2)', description: 'Summe Umsatzsteuer' },
        { name: 'Brutto', type: 'decimal(10,2)', description: 'Summe brutto' },
        text('Waehrung', 'ISO-4217-Code'),
        text('Status', 'finalized, sent, paid oder cancelled'),
        text('PdfSha256', 'gespeicherte SHA-256-Pruefsumme des PDF'),
        text('XmlSha256', 'gespeicherte SHA-256-Pruefsumme des CII-XML'),
        text('XRechnungSha256', 'gespeicherte SHA-256-Pruefsumme der XRechnung'),
        { name: 'AufbewahrungBis', type: 'date', description: 'Ende der Aufbewahrungsfrist' },
        text('Integritaet', 'ok oder abweichung'),
      ],
    },
    null,
    2,
  )}\n`;
}

/** Datei- und Ordnername aus einer Rechnungsnummer (`2026-001`), nie ein Pfadtrenner. */
export function safeName(value: string): string {
  return value.replace(/[^\w-]/g, '_');
}

export interface GobdRange {
  from: string;
  to: string;
}

export type ChunkWriter = (chunk: Uint8Array) => Promise<void> | void;

/**
 * GoBD-EXPORT (Datentraegerueberlassung / Pruefer-Zugriff Z3).
 *
 * Erzeugt ein ZIP-Archiv der festgeschriebenen Rechnungen eines Zeitraums und
 * schreibt es Stueck fuer Stueck an `write`, ohne das Archiv im Speicher zu
 * halten (je Seite von 50 Rechnungen). Nur lesend; schreibt allein einen
 * Audit-Eintrag (`invoice.gobd_export`).
 */
@Injectable()
export class GobdExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Validiert Zeitraum und Menge. Wirft BEVOR irgendein Byte gesendet wird. */
  async prepare(range: GobdRange): Promise<{ count: number }> {
    if (range.from > range.to) throw new GobdExportRangeError();
    const count = await this.prisma.invoice.count({ where: this.where(range) });
    if (count > GOBD_EXPORT_MAX_INVOICES) throw new GobdExportTooLargeError(count);
    return { count };
  }

  filename(range: GobdRange): string {
    return `gobd-export_${range.from}_${range.to}.zip`;
  }

  async stream(
    range: GobdRange,
    actor: Actor,
    source: InquirySource,
    write: ChunkWriter,
  ): Promise<{ count: number }> {
    const { count } = await this.prepare(range);

    // VOR dem ersten Byte protokollieren: Ein Abbruch mitten im Strom darf den
    // Zugriff nicht ungeschehen machen.
    await this.audit.log({
      userId: actor.userId,
      actor: actor.name,
      action: AUDIT_ACTION.invoiceGobdExport,
      objectType: 'Invoice',
      afterValue: { from: range.from, to: range.to, count },
      ...source,
    });

    const pending: Uint8Array[] = [];
    let failure: Error | null = null;
    const zip = new Zip((error, chunk) => {
      if (error) failure = error;
      else pending.push(chunk);
    });
    const flush = async (): Promise<void> => {
      if (failure) throw failure;
      while (pending.length > 0) await write(pending.shift() as Uint8Array);
    };
    const exportedAt = new Date();
    const hashes: { path: string; sha256: string }[] = [];

    const addFile = async (
      path: string,
      data: Uint8Array,
      mtime: Date,
      compress: boolean,
    ): Promise<void> => {
      const file = compress ? new ZipDeflate(path, { level: 6 }) : new ZipPassThrough(path);
      file.mtime = mtime;
      zip.add(file);
      file.push(data, true);
      hashes.push({ path, sha256: sha256Hex(data) });
      await flush();
    };
    const text = (value: string): Uint8Array => new TextEncoder().encode(value);

    await addFile('README.txt', text(buildReadme(range, count)), exportedAt, true);

    const rows: IndexRow[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.prisma.invoice.findMany({
        where: this.where(range),
        orderBy: { invoiceNumber: 'asc' },
        take: PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          invoiceNumber: true,
          invoiceDate: true,
          finalizedAt: true,
          status: true,
          currency: true,
          recipientName: true,
          retentionUntil: true,
          pdfContent: true,
          xmlContent: true,
          xrechnungContent: true,
          pdfSha256: true,
          xmlSha256: true,
          xrechnungSha256: true,
          lines: { select: { netAmount: true, taxAmount: true, grossAmount: true } },
        },
      });
      if (page.length === 0) break;

      for (const invoice of page) {
        const number = invoice.invoiceNumber as string;
        const year = /^(\d{4})-/.exec(number)?.[1] ?? String(invoice.invoiceDate.getUTCFullYear());
        const base = `invoices/${year}/${safeName(number)}`;
        const mtime = invoice.finalizedAt ?? exportedAt;
        const names: Record<(typeof DOCUMENT_COLUMNS)[number]['format'], string> = {
          pdf: `${base}.pdf`,
          xml: `${base}.xml`,
          xrechnung: `${base}-xrechnung.xml`,
        };
        let integrity: IndexRow['integrity'] = 'ok';
        for (const column of DOCUMENT_COLUMNS) {
          const content = invoice[column.content];
          if (isFailure(checkDocument(content, invoice[column.hash]).status)) {
            integrity = 'abweichung';
          }
          // Was gespeichert ist, kommt UNVERAENDERT ins Archiv — auch bei
          // Abweichung; der Pruefer soll die Wahrheit sehen, und
          // `hashes.sha256` fuehrt die tatsaechlichen Bytes.
          if (content !== null) {
            await addFile(names[column.format], content, mtime, false);
          }
        }
        const sum = (field: 'netAmount' | 'taxAmount' | 'grossAmount'): number =>
          invoice.lines.reduce((s, l) => s + (decimalAsCent(l[field]) ?? 0), 0);
        rows.push({
          number,
          date: dateStringFromDate(invoice.invoiceDate),
          recipient: invoice.recipientName,
          netCent: sum('netAmount'),
          taxCent: sum('taxAmount'),
          grossCent: sum('grossAmount'),
          currency: invoice.currency,
          status: invoice.status,
          pdfSha256: invoice.pdfSha256,
          xmlSha256: invoice.xmlSha256,
          xrechnungSha256: invoice.xrechnungSha256,
          retentionUntil: invoice.retentionUntil
            ? dateStringFromDate(invoice.retentionUntil)
            : null,
          integrity,
        });
      }
      cursor = page[page.length - 1]?.id;
      if (page.length < PAGE_SIZE) break;
    }

    await addFile('index.csv', text(buildIndexCsv(rows)), exportedAt, true);
    await addFile('index-description.json', text(buildIndexDescription()), exportedAt, true);
    // `hashes.sha256` fuehrt alle Dateien AUSSER sich selbst.
    await addFile('hashes.sha256', text(buildHashFile(hashes)), exportedAt, true);

    zip.end();
    await flush();
    return { count };
  }

  private where(range: GobdRange) {
    return {
      finalizedAt: { not: null },
      invoiceNumber: { not: null },
      invoiceDate: { gte: toDate(range.from), lte: toDate(range.to) },
    };
  }
}
