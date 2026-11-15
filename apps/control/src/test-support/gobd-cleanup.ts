import type { PrismaService } from '../prisma/prisma.service';

/**
 * GoBD-TRIGGER UND TESTAUFRAEUMEN.
 *
 * Die Datenbank blockiert DELETE/UPDATE auf festgeschriebene Rechnungen und
 * ihre Posten sowie auf das AuditLog (Trigger der Baseline-Migration).
 * Produktivcode hat dafuer KEINEN Umgehungsweg. Die Testaufraeumpfade nutzen
 * TRUNCATE, das diese Trigger nicht ausloest (die Anwendungsrolle in
 * Produktion darf TRUNCATE nicht besitzen).
 *
 * Die Integrationstests laufen seriell gegen ihre EIGENE Datenbank
 * (`..._integration`); das Leeren dieser Tabellen trifft nur Reste
 * frueherer Suiten. NUR aus Testcode verwenden.
 */
export async function truncateAuditLog(client: PrismaService): Promise<void> {
  await client.$executeRawUnsafe('TRUNCATE TABLE "AuditLog"');
}

/** Leert Rechnungen samt Posten (TRUNCATE ... CASCADE). */
export async function truncateInvoices(client: PrismaService): Promise<void> {
  await client.$executeRawUnsafe(
    'TRUNCATE TABLE "InvoiceLine", "Invoice" CASCADE',
  );
}
