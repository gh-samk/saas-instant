import { createHash } from 'node:crypto';
import type { ArchiveDocKind, ControlClient } from './control-client.js';
import type { InvoiceDoc, InvoiceSource } from './jobs/context.js';

const MAX_PAGES = 100_000;

/**
 * Liest festgeschriebene Rechnungen ueber den Verwaltungs-Endpunkt (seitenweise). Jedes Dokument wird
 * gegen die mitgelieferte SHA-256 geprueft; bei Abweichung bricht der Lauf ab (nichts Beschaedigtes
 * landet im unveraenderlichen Archiv). Gruppiert nach dem Jahr der Festschreibung (UTC).
 */
export function controlInvoiceSource(control: ControlClient): InvoiceSource {
  let skipped: { number: string; reason: string }[] = [];
  return {
    skipped: () => skipped,
    async fetchAll() {
      skipped = [];
      const byYear = new Map<string, InvoiceDoc[]>();
      const seen = new Set<string>();
      let after: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await control.getInvoiceArchivePage(after);
        for (const sk of res.skipped ?? []) skipped.push({ number: sk.number, reason: sk.reason });
        for (const item of res.items) {
          const t = new Date(item.finalizedAt);
          if (Number.isNaN(t.getTime())) throw new Error(`Rechnung ${item.number}: Festschreibedatum ungueltig`);
          const doc: InvoiceDoc = { number: item.number };
          for (const d of item.documents) {
            const buf = Buffer.from(d.base64, 'base64');
            const actual = createHash('sha256').update(buf).digest('hex');
            if (actual !== d.sha256.toLowerCase()) {
              throw new Error(`Rechnung ${item.number}: Pruefsumme des Dokuments (${d.kind}) stimmt nicht, Archivierung abgebrochen`);
            }
            assign(doc, d.kind, buf);
          }
          const key = `${item.invoiceId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const year = String(t.getUTCFullYear());
          const list = byYear.get(year) ?? [];
          list.push(doc);
          byYear.set(year, list);
        }
        if (!res.next) {
          for (const list of byYear.values()) list.sort((a, b) => a.number.localeCompare(b.number));
          return byYear;
        }
        if (res.next === after) throw new Error('Rechnungsarchiv: Seitenmarke wiederholt sich');
        after = res.next;
      }
      throw new Error('Rechnungsarchiv: zu viele Seiten');
    },
  };
}

function assign(doc: InvoiceDoc, kind: ArchiveDocKind, buf: Buffer): void {
  if (kind === 'pdf') doc.pdf = buf;
  else if (kind === 'xml') doc.xml = buf;
  else doc.xrechnung = buf;
}
