import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import type { InquirySource } from '../common/inquiry-source';
import { FieldDecryptError } from '../crypto/field-crypto';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceNotFoundError } from './invoice.errors';
import {
  DOCUMENT_COLUMNS,
  checkDocument,
  documentLine,
  findNumberGaps,
  type DocumentFormatKey,
  type DocumentStatus,
  type IntegrityCheckLine,
  type IntegrityResult,
  type NumberCheckResult,
} from './integrity';
import { splitNumber } from './number-sequence';
import type { Actor } from './invoice.service';

/** Akteur des naechtlichen Laufs im Audit-Log. */
export const INTEGRITY_ACTOR = 'system:integrity';

/** Je Befund schreibt der naechtliche Lauf hoechstens alle so viele Tage einen Audit-Eintrag. */
export const INTEGRITY_AUDIT_DEDUPE_DAYS = 7;

/** Hoechstzahl Befunde je Lauf, die einzeln ins Audit-Log gehen. */
const MAX_FINDINGS = 500;

export interface DocumentFinding {
  id: string;
  invoiceNumber: string | null;
  /**
   * Nur die auffaelligen Formate. Ein nicht entschluesselbares Dokument steht
   * hier als `mismatch` (der Authentisierungswert der Verschluesselung ist die
   * Pruefsumme, die nicht passt) UND zusaetzlich in `undecryptable`.
   */
  formats: { format: DocumentFormatKey; status: DocumentStatus }[];
  /** Formate, deren Chiffretext sich nicht entschluesseln liess (veraendert oder falscher Schluessel). */
  undecryptable?: DocumentFormatKey[];
}

export interface DocumentFindings {
  findings: DocumentFinding[];
  /** Wie viele Rechnungen insgesamt auffaellig sind (kann > findings.length sein). */
  total: number;
}

type InvoiceDb = Pick<PrismaService, 'invoice'>;

/** Wie viele Rechnungen je Durchgang geladen werden (die Dokumente sind gross). */
const FINDINGS_PAGE_SIZE = 50;

const META_SELECT = {
  id: true,
  invoiceNumber: true,
  finalizedAt: true,
  pdfSha256: true,
  xmlSha256: true,
  xrechnungSha256: true,
} as const;

const DOCUMENT_SELECT = {
  ...META_SELECT,
  pdfContent: true,
  xmlContent: true,
  xrechnungContent: true,
} as const;

/** Eine Rechnung mit ihren Dokumenten; unlesbare Spalten stehen als `null` UND in `undecryptable`. */
export interface LoadedDocumentRow {
  id: string;
  invoiceNumber: string | null;
  finalizedAt: Date | null;
  pdfContent: Uint8Array | null;
  xmlContent: Uint8Array | null;
  xrechnungContent: Uint8Array | null;
  pdfSha256: string | null;
  xmlSha256: string | null;
  xrechnungSha256: string | null;
}

export interface LoadedDocuments {
  row: LoadedDocumentRow;
  undecryptable: DocumentFormatKey[];
}

/**
 * Laedt EINE Rechnung samt Dokumenten und faengt Entschluesselungsfehler ab.
 *
 * Normalfall: ein Zugriff. Wirft die Entschluesselung (`FieldDecryptError`:
 * Chiffretext veraendert), wird jede Dokumentspalte einzeln gelesen; die
 * unlesbaren werden benannt, die uebrigen bleiben pruefbar. Andere Fehler
 * (gesperrter Tresor, Datenbank) laufen unveraendert durch.
 */
export async function loadDocuments(
  db: InvoiceDb,
  id: string,
): Promise<LoadedDocuments | null> {
  try {
    const row = await db.invoice.findUnique({ where: { id }, select: DOCUMENT_SELECT });
    return row ? { row: row as LoadedDocumentRow, undecryptable: [] } : null;
  } catch (error) {
    if (!(error instanceof FieldDecryptError)) throw error;
  }
  const meta = await db.invoice.findUnique({ where: { id }, select: META_SELECT });
  if (!meta) return null;
  const row = {
    ...meta,
    pdfContent: null,
    xmlContent: null,
    xrechnungContent: null,
  } as unknown as LoadedDocumentRow;
  const undecryptable: DocumentFormatKey[] = [];
  for (const column of DOCUMENT_COLUMNS) {
    try {
      const part = (await db.invoice.findUnique({
        where: { id },
        select: { id: true, [column.content]: true },
      })) as Record<string, Uint8Array | null> | null;
      (row as unknown as Record<string, unknown>)[column.content] = part?.[column.content] ?? null;
    } catch (error) {
      if (!(error instanceof FieldDecryptError)) throw error;
      undecryptable.push(column.format);
    }
  }
  return { row, undecryptable };
}

/**
 * Prueft die geladenen Dokumente EINER Rechnung. Unlesbare Formate gelten als
 * Befund `undecryptable`; sie werden nicht gegen die Pruefsumme gerechnet
 * (es gibt keine Bytes).
 */
function checkLoaded(loaded: LoadedDocuments) {
  return DOCUMENT_COLUMNS.map((c) => {
    if (loaded.undecryptable.includes(c.format)) {
      return { column: c, undecryptable: true as const };
    }
    return { column: c, undecryptable: false as const, check: checkDocument(loaded.row[c.content], loaded.row[c.hash]) };
  });
}

/**
 * Findet Rechnungen, deren gespeicherte Dokumente nicht zu ihren Pruefsummen
 * passen — oder sich gar nicht mehr entschluesseln lassen. Dieselbe Bedeutung
 * wie `checkDocument` in `integrity.ts`.
 *
 * Die Dokumentspalten sind verschluesselt; die Pruefsummen gelten dem KLARTEXT.
 * Deshalb laedt der erweiterte Client die Rechnungen seitenweise (er
 * entschluesselt beim Lesen) und die Pruefsumme wird hier ueber die
 * entschluesselten Bytes gebildet. Rechnet man in der Datenbank, hasht man den
 * Chiffretext und meldet fuer jede neue Zeile eine Abweichung.
 *
 * EIN VERAENDERTER CHIFFRETEXT BRICHT DEN LAUF NICHT AB: scheitert eine Seite an
 * der Entschluesselung, wird sie Zeile fuer Zeile (und Spalte fuer Spalte)
 * gelesen und die betroffene Rechnung als Befund gefuehrt (`undecryptable`).
 *
 * Nur festgeschriebene Rechnungen. Liest ausschliesslich.
 */
export async function findDocumentFindings(
  db: InvoiceDb,
  limit: number = MAX_FINDINGS,
): Promise<DocumentFindings> {
  const all: DocumentFinding[] = [];
  const consider = (loaded: LoadedDocuments): void => {
    const results = checkLoaded(loaded);
    const formats: DocumentFinding['formats'] = [];
    const undecryptable: DocumentFormatKey[] = [];
    for (const r of results) {
      if (r.undecryptable) {
        formats.push({ format: r.column.format, status: 'mismatch' });
        undecryptable.push(r.column.format);
      } else if (r.check.status !== 'ok' && r.check.status !== 'absent') {
        formats.push({ format: r.column.format, status: r.check.status });
      }
    }
    if (formats.length > 0) {
      all.push({
        id: loaded.row.id,
        invoiceNumber: loaded.row.invoiceNumber,
        formats,
        ...(undecryptable.length > 0 ? { undecryptable } : {}),
      });
    }
  };

  let cursor: string | undefined;
  for (;;) {
    const paging = {
      where: { finalizedAt: { not: null } },
      orderBy: { id: 'asc' as const },
      take: FINDINGS_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    };
    let ids: string[];
    try {
      const page = await db.invoice.findMany({ ...paging, select: DOCUMENT_SELECT });
      for (const row of page) consider({ row: row as LoadedDocumentRow, undecryptable: [] });
      ids = page.map((r) => r.id);
    } catch (error) {
      if (!(error instanceof FieldDecryptError)) throw error;
      // Mindestens eine Zeile dieser Seite ist unlesbar: Zeile fuer Zeile neu.
      ids = (await db.invoice.findMany({ ...paging, select: { id: true } })).map((r) => r.id);
      for (const id of ids) {
        const loaded = await loadDocuments(db, id);
        if (loaded) consider(loaded);
      }
    }
    if (ids.length === 0) break;
    cursor = ids[ids.length - 1];
    if (ids.length < FINDINGS_PAGE_SIZE) break;
  }
  // Wie vorher in SQL: nach Rechnungsnummer (NULL zuletzt), dann id.
  all.sort((a, b) => {
    if (a.invoiceNumber === b.invoiceNumber) return a.id < b.id ? -1 : 1;
    if (a.invoiceNumber === null) return 1;
    if (b.invoiceNumber === null) return -1;
    return a.invoiceNumber < b.invoiceNumber ? -1 : 1;
  });
  return { findings: all.slice(0, limit), total: all.length };
}

/** Alle vergebenen Rechnungsnummern (optional eines Jahres). */
export async function allInvoiceNumbers(
  prisma: Pick<PrismaService, 'invoice'>,
  year?: number,
): Promise<string[]> {
  const rows = await prisma.invoice.findMany({
    where: {
      invoiceNumber:
        year === undefined ? { not: null } : { startsWith: `${year}-` },
    },
    select: { invoiceNumber: true },
  });
  return rows.map((r) => r.invoiceNumber as string);
}

export interface NightlyResult {
  documentFindings: number;
  gapYears: number[];
  audited: number;
}

/**
 * INTEGRITAETSPRUEFUNG FESTGESCHRIEBENER RECHNUNGEN (GoBD).
 *
 * Prueft SHA-256 von PDF, XML und XRechnung gegen die beim Erzeugen gespeicherten
 * Pruefsummen und den Nummernkreis auf Luecken. Das Ergebnis wird NICHT an der
 * Rechnung gespeichert (die Trigger erlauben das nach dem Festschreiben nicht und
 * sollen es auch nicht), sondern bei Abweichung als Audit-Eintrag
 * `invoice.integrity_failed` festgehalten und als Aufgabe `document_tampered`
 * live berechnet.
 *
 * Diese Klasse schreibt nie an `Invoice` — nur ins Audit-Log.
 */
@Injectable()
export class IntegrityService {
  private readonly logger = new Logger(IntegrityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * `GET invoices/:id/integrity`. Ein Befund wird zusaetzlich ins Audit-Log
   * geschrieben (wer hat wann eine Abweichung festgestellt).
   */
  async check(
    id: string,
    actor: Actor,
    source: InquirySource,
  ): Promise<IntegrityResult> {
    const loaded = await loadDocuments(this.prisma, id);
    if (!loaded) throw new InvoiceNotFoundError();
    const row = loaded.row;

    const result: IntegrityResult = {
      invoiceId: row.id,
      invoiceNumber: row.invoiceNumber,
      finalized: row.finalizedAt !== null,
      ok: true,
      checkedAt: new Date().toISOString(),
      checks: [],
    };
    if (row.finalizedAt === null) return result;

    for (const r of checkLoaded(loaded)) {
      if (r.undecryptable) {
        // Chiffretext veraendert (oder falscher Schluessel): ein Befund wie ein
        // Pruefsummenfehler, nur ohne Bytes zum Vergleichen.
        result.checks.push({
          check: `${r.column.format}_sha256`,
          ok: false,
          status: 'undecryptable',
          detail: { model: 'Invoice', field: r.column.content },
        });
      } else {
        result.checks.push(documentLine(r.column.format, r.check));
      }
    }

    const parts = row.invoiceNumber ? splitNumber(row.invoiceNumber) : null;
    if (parts !== null) {
      const numbers = await allInvoiceNumbers(this.prisma, parts.year);
      result.checks.push(sequenceLine(findNumberGaps(numbers, { onlyYear: parts.year })));
    }

    result.ok = result.checks.every((c) => c.ok);
    if (!result.ok) {
      await this.audit.log({
        userId: actor.userId,
        actor: actor.name,
        action: AUDIT_ACTION.invoiceIntegrityFailed,
        objectType: 'Invoice',
        objectId: id,
        afterValue: {
          invoiceNumber: row.invoiceNumber,
          trigger: 'manual',
          failed: result.checks.filter((c) => !c.ok),
        },
        ...source,
      });
    }
    return result;
  }

  /**
   * Gab es in den letzten `INTEGRITY_AUDIT_DEDUPE_DAYS` Tagen schon einen
   * Eintrag des naechtlichen Laufs zu diesem Gegenstand? (Sonst fuellte ein
   * dauerhafter Befund das Audit-Log jede Nacht erneut.)
   */
  private async reportedRecently(
    objectType: string,
    objectId: string,
    now: Date,
  ): Promise<boolean> {
    const since = new Date(now.getTime() - INTEGRITY_AUDIT_DEDUPE_DAYS * 86_400_000);
    const existing = await this.prisma.auditLog.findFirst({
      where: {
        action: AUDIT_ACTION.invoiceIntegrityFailed,
        actor: INTEGRITY_ACTOR,
        objectType,
        objectId,
        timestamp: { gte: since },
      },
      select: { id: true },
    });
    return existing !== null;
  }

  /**
   * Der volle Lauf ueber alle festgeschriebenen Rechnungen. Schreibt je Befund
   * einen Audit-Eintrag (Akteur `system:integrity`), aber je Rechnung bzw.
   * Nummernkreis-Jahr hoechstens einen alle 7 Tage (`audited` zaehlt nur die
   * tatsaechlich geschriebenen).
   */
  async runAll(now: Date = new Date()): Promise<NightlyResult> {
    const documents = await findDocumentFindings(this.prisma, MAX_FINDINGS);
    let audited = 0;
    for (const finding of documents.findings) {
      if (await this.reportedRecently('Invoice', finding.id, now)) continue;
      await this.audit.log({
        userId: null,
        actor: INTEGRITY_ACTOR,
        action: AUDIT_ACTION.invoiceIntegrityFailed,
        objectType: 'Invoice',
        objectId: finding.id,
        afterValue: {
          invoiceNumber: finding.invoiceNumber,
          trigger: 'nightly',
          // Nicht entschluesselbare Formate mit ihrem genauen Befund statt `mismatch`.
          formats: finding.formats.map((f) =>
            finding.undecryptable?.includes(f.format)
              ? { format: f.format, status: 'undecryptable' }
              : f,
          ),
        },
      });
      audited++;
    }

    const numbers = await allInvoiceNumbers(this.prisma);
    const sequence = findNumberGaps(numbers);
    for (const gap of sequence.gaps) {
      if (await this.reportedRecently('InvoiceNumberSequence', String(gap.year), now)) continue;
      await this.audit.log({
        userId: null,
        actor: INTEGRITY_ACTOR,
        action: AUDIT_ACTION.invoiceIntegrityFailed,
        objectType: 'InvoiceNumberSequence',
        objectId: String(gap.year),
        afterValue: {
          trigger: 'nightly',
          check: 'number_sequence',
          year: gap.year,
          missing: gap.missing,
          missingTotal: gap.missingTotal,
          highest: gap.highest,
        },
      });
      audited++;
    }
    return {
      documentFindings: documents.total,
      gapYears: sequence.gaps.map((g) => g.year),
      audited,
    };
  }

  /** Nachts um 02:40 (Serverzeit). Ein Fehler darf den Prozess nicht beruehren. */
  @Cron('0 40 2 * * *', { name: 'invoice-integrity' })
  async nightlyRun(): Promise<void> {
    try {
      const result = await this.runAll();
      if (result.documentFindings > 0 || result.gapYears.length > 0) {
        this.logger.warn(
          `Integritaetslauf: ${result.documentFindings} Beleg(e) mit Abweichung, ` +
            `Nummernkreis-Luecken in ${result.gapYears.join(', ') || '-'}.`,
        );
      } else {
        this.logger.log('Integritaetslauf ohne Abweichung.');
      }
    } catch (error) {
      this.logger.error(
        `Integritaetslauf fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** Die Pruefzeile `number_sequence` aus dem Ergebnis der Lueckenpruefung. */
export function sequenceLine(result: NumberCheckResult): IntegrityCheckLine {
  const ok =
    result.gaps.length === 0 &&
    result.unparseable.length === 0 &&
    result.duplicates.length === 0;
  const line: IntegrityCheckLine = {
    check: 'number_sequence',
    ok,
    status: ok ? 'ok' : 'gap',
  };
  if (!ok) {
    line.detail = {
      gaps: result.gaps,
      unparseable: result.unparseable,
      duplicates: result.duplicates,
    };
  }
  return line;
}
