import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import type { InquirySource } from '../common/inquiry-source';
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
  /** Nur die auffaelligen Formate. */
  formats: { format: DocumentFormatKey; status: DocumentStatus }[];
}

export interface DocumentFindings {
  findings: DocumentFinding[];
  /** Wie viele Rechnungen insgesamt auffaellig sind (kann > findings.length sein). */
  total: number;
}

type InvoiceDb = Pick<PrismaService, 'invoice'>;

/** Wie viele Rechnungen je Durchgang geladen werden (die Dokumente sind gross). */
const FINDINGS_PAGE_SIZE = 50;

/**
 * Findet Rechnungen, deren gespeicherte Dokumente nicht zu ihren Pruefsummen
 * passen. Dieselbe Bedeutung wie `checkDocument` in `integrity.ts`.
 *
 * Die Dokumentspalten sind verschluesselt; die Pruefsummen gelten dem KLARTEXT.
 * Deshalb laedt der erweiterte Client die Rechnungen seitenweise (er
 * entschluesselt beim Lesen) und die Pruefsumme wird hier ueber die
 * entschluesselten Bytes gebildet. Rechnet man in der Datenbank, hasht man den
 * Chiffretext und meldet fuer jede neue Zeile eine Abweichung.
 *
 * Nur festgeschriebene Rechnungen. Liest ausschliesslich.
 */
export async function findDocumentFindings(
  db: InvoiceDb,
  limit: number = MAX_FINDINGS,
): Promise<DocumentFindings> {
  const all: DocumentFinding[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await db.invoice.findMany({
      where: { finalizedAt: { not: null } },
      orderBy: { id: 'asc' },
      take: FINDINGS_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        invoiceNumber: true,
        pdfContent: true,
        xmlContent: true,
        xrechnungContent: true,
        pdfSha256: true,
        xmlSha256: true,
        xrechnungSha256: true,
      },
    });
    if (page.length === 0) break;
    for (const row of page) {
      const formats = DOCUMENT_COLUMNS.map((c) => ({
        format: c.format,
        status: checkDocument(row[c.content], row[c.hash]).status,
      })).filter((f) => f.status !== 'ok' && f.status !== 'absent');
      if (formats.length > 0) {
        all.push({ id: row.id, invoiceNumber: row.invoiceNumber, formats });
      }
    }
    cursor = page[page.length - 1].id;
    if (page.length < FINDINGS_PAGE_SIZE) break;
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
    const row = await this.prisma.invoice.findUnique({
      where: { id },
      select: {
        id: true,
        invoiceNumber: true,
        finalizedAt: true,
        pdfContent: true,
        xmlContent: true,
        xrechnungContent: true,
        pdfSha256: true,
        xmlSha256: true,
        xrechnungSha256: true,
      },
    });
    if (!row) throw new InvoiceNotFoundError();

    const result: IntegrityResult = {
      invoiceId: row.id,
      invoiceNumber: row.invoiceNumber,
      finalized: row.finalizedAt !== null,
      ok: true,
      checkedAt: new Date().toISOString(),
      checks: [],
    };
    if (row.finalizedAt === null) return result;

    result.checks.push(
      ...DOCUMENT_COLUMNS.map((c) =>
        documentLine(c.format, checkDocument(row[c.content], row[c.hash])),
      ),
    );

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
          formats: finding.formats,
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
