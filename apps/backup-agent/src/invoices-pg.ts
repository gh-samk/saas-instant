import pg from 'pg';
import type { InvoiceDoc, InvoiceSource } from './jobs/context.js';

/** Liest festgeschriebene Rechnungen (nicht Entwurf, mit Nummer) lesend aus der Verwaltungs-DB. */
export function pgInvoiceSource(connectionString: string): InvoiceSource {
  const withClient = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
    const c = new pg.Client({ connectionString: stripPrismaParams(connectionString) });
    await c.connect();
    try {
      await c.query('SET default_transaction_read_only = on');
      return await fn(c);
    } finally {
      await c.end().catch(() => undefined);
    }
  };
  const where = `"invoiceNumber" is not null and status <> 'draft'`;
  return {
    async years() {
      return withClient(async (c) => {
        const r = await c.query<{ y: string }>(
          `select distinct to_char("invoiceDate", 'YYYY') as y from "Invoice" where ${where} order by 1`,
        );
        return r.rows.map((x) => x.y);
      });
    },
    async *ofYear(year: string): AsyncGenerator<InvoiceDoc> {
      const c = new pg.Client({ connectionString: stripPrismaParams(connectionString) });
      await c.connect();
      try {
        await c.query('SET default_transaction_read_only = on');
        const ids = await c.query<{ id: string }>(
          `select id from "Invoice" where ${where} and to_char("invoiceDate", 'YYYY') = $1 order by "invoiceNumber"`,
          [year],
        );
        for (const { id } of ids.rows) {
          const r = await c.query<{ n: string; pdf: Buffer | null; xml: Buffer | null; xr: Buffer | null }>(
            `select "invoiceNumber" as n, "pdfContent" as pdf, "xmlContent" as xml, "xrechnungContent" as xr from "Invoice" where id = $1`,
            [id],
          );
          const row = r.rows[0];
          if (row) yield { number: row.n, pdf: row.pdf, xml: row.xml, xrechnung: row.xr };
        }
      } finally {
        await c.end().catch(() => undefined);
      }
    },
  };
}

/** Prisma haengt `?schema=public` an; pg kennt den Parameter nicht. */
export function stripPrismaParams(url: string): string {
  const u = new URL(url);
  u.searchParams.delete('schema');
  return u.toString();
}
