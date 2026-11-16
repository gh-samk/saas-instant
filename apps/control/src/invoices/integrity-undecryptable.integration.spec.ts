import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { datePlusDays } from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import { FieldDecryptError } from '../crypto/field-crypto';
import {
  cleanUp,
  createCompany,
  disconnect,
  newPrefix,
  prisma,
} from '../test-support/company-provisioning';
import {
  clearDocumentTamperedCache,
  documentTampered,
} from '../tasks/sources/document-tampered.source';
import { IssuerConfigService } from './document/issuer.config';
import type { InvoiceRenderer } from './document/invoice-renderer.client';
import { InvoiceDocumentService } from './document.service';
import {
  INTEGRITY_ACTOR,
  IntegrityService,
  findDocumentFindings,
} from './integrity.service';
import { InvoiceArchiveService } from './invoice-archive.service';
import { InvoiceService } from './invoice.service';
import { PRICE_PRESETS, PricingConfigService } from './pricing.config';

/**
 * VERAENDERTER CHIFFRETEXT (nicht nur veraenderter Klartext) GEGEN ECHTES POSTGRES.
 *
 * `gobd.integration.spec.ts` ueberschreibt die Dokumentspalte mit Klartext; das
 * prueft die Pruefsumme, nicht die Verschluesselung. Hier kippt ein Bit IM
 * CHIFFRETEXT. Der GCM-Pruefwert schlaegt beim Lesen fehl, und weder der
 * Integritaetslauf noch die Einzelpruefung noch das Archiv duerfen daran
 * abbrechen: der Fall ist ein Befund, kein 500.
 */

jest.setTimeout(180_000);

const PREFIX = newPrefix('undec');
const SOURCE = { ip: '203.0.113.11', userAgent: 'Jest-Integration' };
const actor = { userId: null, name: 'sam' };
const YEAR = 2092;

const ISSUER_ENV: Record<string, string> = {
  CONTROL_INVOICE_ISSUER: 'Testhaus Software GmbH & Co. KG',
  CONTROL_INVOICE_STREET: 'Werkstattweg 7',
  CONTROL_INVOICE_POSTAL_CODE: '36037',
  CONTROL_INVOICE_CITY: 'Fulda',
  CONTROL_INVOICE_SEAT: 'Fulda',
  CONTROL_INVOICE_USTIDNR: 'DE811569869',
  CONTROL_INVOICE_COMMERCIAL_REGISTER_A: 'HRA 12345',
  CONTROL_INVOICE_REGISTER_COURT: 'Amtsgericht Fulda',
  CONTROL_INVOICE_GENERAL_PARTNER: 'Testhaus Verwaltungs GmbH',
  CONTROL_INVOICE_GENERAL_PARTNER_SEAT: 'Fulda',
  CONTROL_INVOICE_GENERAL_PARTNER_GERICHT: 'Amtsgericht Fulda',
  CONTROL_INVOICE_COMMERCIAL_REGISTER_B: 'HRB 54321',
  CONTROL_INVOICE_MANAGING_DIRECTOR: 'Erika Beispiel',
  CONTROL_INVOICE_CONTACT_NAME: 'Rechnungsstelle Testhaus',
  CONTROL_INVOICE_PHONE: '+49 661 000000',
  CONTROL_INVOICE_EMAIL: 'rechnung@testhaus.example.com',
  CONTROL_INVOICE_BANK: 'Testbank Fulda',
  CONTROL_INVOICE_IBAN: 'DE89370400440532013000',
  CONTROL_INVOICE_BIC: 'COBADEFFXXX',
  CONTROL_INVOICE_CREDITOR_ID: 'DE09ZZZ00000000001',
  CONTROL_INVOICE_DATE_RETROACTIVE_DAYS: '40000',
  CONTROL_INVOICE_DATE_AHEAD_DAYS: '40000',
};
const env = (values: Record<string, string>) =>
  ({ get: (name: string) => values[name] }) as unknown as ConfigService;

const audit = new AuditService(prisma);
const issuer = new IssuerConfigService(env(ISSUER_ENV));
const invoices = new InvoiceService(
  prisma,
  audit,
  new PricingConfigService(env({})),
  issuer,
  env(ISSUER_ENV),
);
const integrity = new IntegrityService(prisma, audit);
const archive = new InvoiceArchiveService(prisma);
const renderer: InvoiceRenderer = {
  isConfigured: () => true,
  create: async (_html, xml) =>
    Buffer.from(`%PDF-1.7 Schein-PDF ${createHash('md5').update(xml).digest('hex')}`),
};
const documents = new InvoiceDocumentService(prisma, audit, issuer, renderer);

async function finalized(label: string): Promise<{ companyId: string; invoiceId: string }> {
  const invoiceDate = `${YEAR}-03-01`;
  const company = await createCompany(PREFIX, {
    street: 'Ziegelgasse',
    houseNumber: '14',
    postalCode: '99423',
    city: 'Weimar',
    country: 'DE',
    contactEmail: `${label}@example.com`,
  });
  const invoice = await invoices.draftCreate(
    company.id,
    {
      invoiceDate,
      servicePeriodFrom: invoiceDate,
      servicePeriodUntil: datePlusDays(invoiceDate, 364),
      lines: [{ label: 'Jahresbeitrag', quantity: 1, unitPriceNetCent: 38_500, taxRate: 19 }],
    },
    actor,
    SOURCE,
  );
  await invoices.finalize(invoice.id, actor, SOURCE);
  await documents.download('pdf', invoice.id, actor, SOURCE);
  return { companyId: company.id, invoiceId: invoice.id };
}

/** Kippt ein Bit im gespeicherten CHIFFRETEXT (letztes Byte), Trigger nur in dieser Transaktion aus. */
async function flipCiphertextBit(invoiceId: string, column: 'pdfContent' | 'xmlContent'): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<{ content: Buffer }[]>(
    `SELECT "${column}" AS content FROM "Invoice" WHERE "id" = $1`,
    invoiceId,
  );
  const blob = Buffer.from(rows[0]!.content);
  expect(blob.subarray(0, 4).toString('ascii')).toBe('ENC1');
  blob[blob.length - 1] = blob[blob.length - 1]! ^ 0x01;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRawUnsafe(`UPDATE "Invoice" SET "${column}" = $1 WHERE "id" = $2`, blob, invoiceId);
  });
}

afterAll(async () => {
  await cleanUp(PREFIX);
  await disconnect();
});

describe('Chiffretext-Manipulation wird zum Befund, nicht zum Abbruch', () => {
  let good: { companyId: string; invoiceId: string };
  let bad: { companyId: string; invoiceId: string };

  beforeAll(async () => {
    good = await finalized('undec-good');
    bad = await finalized('undec-bad');
    await flipCiphertextBit(bad.invoiceId, 'pdfContent');
  });

  it('der Client wirft einen FieldDecryptError mit Modell, Feld und id', async () => {
    const error = await prisma.invoice
      .findUniqueOrThrow({ where: { id: bad.invoiceId }, select: { pdfContent: true } })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(FieldDecryptError);
    expect(error).toMatchObject({ model: 'Invoice', field: 'pdfContent', id: bad.invoiceId });
    // Die Meldung nennt weder Klar- noch Chiffretext.
    expect((error as Error).message).not.toMatch(/ENC1|enc:v1/);
  });

  it('Einzelpruefung: ok=false mit Zeile `undecryptable`, Audit invoice.integrity_failed', async () => {
    const result = await integrity.check(bad.invoiceId, actor, SOURCE);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.check === 'pdf_sha256')).toMatchObject({
      ok: false,
      status: 'undecryptable',
      detail: { model: 'Invoice', field: 'pdfContent' },
    });
    // Die uebrigen Dokumente derselben Rechnung bleiben pruefbar.
    expect(result.checks.find((c) => c.check === 'xml_sha256')?.ok).toBe(true);

    const entries = await prisma.auditLog.findMany({
      where: { action: AUDIT_ACTION.invoiceIntegrityFailed, objectId: bad.invoiceId },
    });
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0]?.afterValue)).toContain('undecryptable');

    expect((await integrity.check(good.invoiceId, actor, SOURCE)).ok).toBe(true);
  });

  it('Befundliste: die manipulierte Rechnung steht drin, die gute nicht, der Lauf bricht nicht ab', async () => {
    const found = await findDocumentFindings(prisma, 500);
    const finding = found.findings.find((f) => f.id === bad.invoiceId);
    expect(finding).toMatchObject({ undecryptable: ['pdf'] });
    expect(finding?.formats).toEqual([{ format: 'pdf', status: 'mismatch' }]);
    expect(found.findings.find((f) => f.id === good.invoiceId)).toBeUndefined();
  });

  it('naechtlicher Lauf: zaehlt den Befund und schreibt Audit mit genauem Status', async () => {
    const result = await integrity.runAll(new Date(Date.now() + 8 * 86_400_000));
    expect(result.documentFindings).toBeGreaterThanOrEqual(1);
    const entries = await prisma.auditLog.findMany({
      where: {
        action: AUDIT_ACTION.invoiceIntegrityFailed,
        actor: INTEGRITY_ACTOR,
        objectId: bad.invoiceId,
      },
    });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(entries[0]?.afterValue)).toContain('undecryptable');
  });

  it('Aufgabe "Beleg manipuliert" entsteht wie beim Pruefsummenfehler', async () => {
    clearDocumentTamperedCache(prisma);
    const tasks = await documentTampered.collect({
      prisma,
      todayDay: `${new Date().getUTCFullYear()}-01-01`,
      now: new Date(),
      since: '2026-01-01',
      limit: 50,
      priceTable: PRICE_PRESETS,
      outbox: [],
    });
    expect(tasks.tasks.find((t) => t.company?.id === bad.companyId)).toMatchObject({
      kind: 'document_tampered',
      title: 'Beleg manipuliert',
      urgency: 'high',
    });
    expect(tasks.tasks.find((t) => t.company?.id === good.companyId)).toBeUndefined();
  });

  it('Archiv: ueberspringt die unlesbare Rechnung, liefert die gute und meldet jene in `skipped`', async () => {
    let after: string | undefined;
    const delivered: string[] = [];
    const skipped: { invoiceId: string; reason: string; fields: string[] }[] = [];
    for (let i = 0; i < 100; i++) {
      const page = await archive.page(after);
      delivered.push(...page.items.map((it) => it.invoiceId));
      skipped.push(...page.skipped);
      if (!page.next) break;
      after = page.next;
    }
    expect(delivered).toContain(good.invoiceId);
    expect(delivered).not.toContain(bad.invoiceId);
    expect(skipped).toContainEqual({
      invoiceId: bad.invoiceId,
      number: expect.any(String),
      reason: 'undecryptable',
      fields: ['pdfContent'],
    });
  });
});
