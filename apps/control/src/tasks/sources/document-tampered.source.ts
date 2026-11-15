import {
  allInvoiceNumbers,
  findDocumentFindings,
  type DocumentFindings,
} from '../../invoices/integrity.service';
import { findNumberGaps, type NumberGap } from '../../invoices/integrity';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SourceResult, Task, TasksContext, TaskSource } from '../tasks.types';

/**
 * „BELEG MANIPULIERT" — Abweichung zwischen gespeichertem Dokument und seiner
 * Pruefsumme, oder Luecke im Rechnungsnummernkreis (GoBD).
 *
 * LIVE BERECHNET, NICHT GESPEICHERT: Das Ergebnis steht in keiner Spalte der
 * Rechnung (die Trigger verbieten es nach dem Festschreiben). Die Pruefsummen
 * werden in der Datenbank gerechnet (`sha256(bytea)`), ohne die Dokumente zu
 * uebertragen. Weil das ueber alle Belege laeuft, wird das Ergebnis kurz
 * (5 Minuten) im Prozess vorgehalten, damit die Startseite es nicht bei jedem
 * Aufruf neu rechnet; der naechtliche Lauf des `IntegrityService` schreibt den
 * dauerhaften Nachweis ins Audit-Log.
 *
 * Es gibt keinen gruenen Haken: Eine Aufgabe entsteht nur im Befundfall. Sie
 * LOESCHT UND REPARIERT NICHTS (R2/R5) — sie fuehrt zur Organisation.
 */
export const DOCUMENT_TAMPERED_CACHE_MS = 5 * 60_000;

interface Snapshot {
  at: number;
  documents: DocumentFindings;
  gaps: NumberGap[];
}

const cache = new WeakMap<PrismaService, Snapshot>();

/** Nur fuer Tests: erzwingt eine frische Berechnung. */
export function clearDocumentTamperedCache(prisma?: PrismaService): void {
  if (prisma) cache.delete(prisma);
}

async function snapshot(context: TasksContext): Promise<Snapshot> {
  const cached = cache.get(context.prisma);
  if (cached && context.now.getTime() - cached.at < DOCUMENT_TAMPERED_CACHE_MS) {
    return cached;
  }
  const documents = await findDocumentFindings(context.prisma, context.limit);
  const gaps = findNumberGaps(await allInvoiceNumbers(context.prisma)).gaps;
  const fresh = { at: context.now.getTime(), documents, gaps };
  cache.set(context.prisma, fresh);
  return fresh;
}

const FORMAT_LABEL = { pdf: 'PDF', xml: 'XML', xrechnung: 'XRechnung' } as const;
const STATUS_LABEL = {
  mismatch: 'Prüfsumme stimmt nicht',
  missing_content: 'Dokument fehlt',
  missing_hash: 'keine Prüfsumme gespeichert',
  ok: 'in Ordnung',
  absent: 'nicht erzeugt',
} as const;

export const documentTampered: TaskSource = {
  kind: 'document_tampered',

  async collect(context: TasksContext): Promise<SourceResult> {
    const { documents, gaps } = await snapshot(context);
    const day = context.todayDay;

    const invoiceIds = documents.findings.map((f) => f.id);
    const companies =
      invoiceIds.length === 0
        ? []
        : await context.prisma.invoice.findMany({
            where: { id: { in: invoiceIds } },
            select: {
              id: true,
              company: { select: { id: true, name: true, status: true } },
            },
          });
    const companyOf = new Map(companies.map((c) => [c.id, c.company]));

    const tasks: Task[] = documents.findings.map((finding) => {
      const company = companyOf.get(finding.id);
      const detail = finding.formats
        .map((f) => `${FORMAT_LABEL[f.format]}: ${STATUS_LABEL[f.status]}`)
        .join('; ');
      return {
        kind: 'document_tampered',
        dueAt: day,
        urgency: 'high',
        title: 'Beleg manipuliert',
        reason:
          `Bei Rechnung ${finding.invoiceNumber ?? finding.id} passt das gespeicherte ` +
          `Dokument nicht zu seiner Prüfsumme (${detail}). Bitte aus der Sicherung ` +
          'prüfen; festgeschriebene Belege werden nicht verändert oder neu erzeugt.',
        action: company
          ? {
              kind: 'company_open',
              label: 'Organisation öffnen',
              target: `/companies/${company.id}`,
            }
          : { kind: 'company_open', label: 'Rechnungen öffnen', target: '/invoices' },
        ...(company ? { company } : {}),
      } satisfies Task;
    });

    for (const gap of gaps) {
      tasks.push({
        kind: 'document_tampered',
        dueAt: day,
        urgency: 'high',
        title: 'Lücke im Rechnungsnummernkreis',
        reason:
          `Im Jahr ${gap.year} fehlen ${gap.missingTotal} Nummer(n) bis ` +
          `${gap.year}-${String(gap.highest).padStart(3, '0')}: ` +
          `${gap.missing.map((n) => `${gap.year}-${String(n).padStart(3, '0')}`).join(', ')}` +
          (gap.missingTotal > gap.missing.length ? ' …' : '') +
          '. Der Kreis muss lückenlos sein; bitte mit der Steuerberatung klären.',
        action: {
          kind: 'company_open',
          label: 'Rechnungen öffnen',
          target: '/invoices',
        },
      });
    }

    const total = documents.total + gaps.length;
    return { tasks: tasks.slice(0, context.limit), total };
  },
};

