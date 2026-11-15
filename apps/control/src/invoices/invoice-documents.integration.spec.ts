import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '.prisma/control-client';
import { datePlusDays } from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import {
  cleanUp,
  createCompany,
  disconnect,
  newPrefix,
  prisma,
} from '../test-support/company-provisioning';
import { IssuerConfigService } from './document/issuer.config';
import { documentIssuerFromCurrent as documentIssuerFromCurrentForTest } from './document/issuer-mapping';
import type { InvoiceRenderer } from './document/invoice-renderer.client';
import type { CiiProfile } from './document/document.types';
import { InvoiceDocumentService } from './document.service';
import {
  InvoiceIncompleteError,
  InvoiceIssuerPlaceholderError,
} from './invoice.errors';
import { InvoiceService, retentionEnd } from './invoice.service';
import { PricingConfigService } from './pricing.config';

/**
 * Entwurf → Festschreiben → PDF / XML / XRechnung gegen echtes Postgres.
 *
 * Der Rechnungsdienst ist ein TEST-DOUBLE (kein Chromium, kein Java): Er
 * zeichnet auf, was er bekommt (HTML, XML, Profil), und liefert ein
 * Schein-PDF. Geprüft wird, was UNSERE Seite verantwortet: Schnappschuss,
 * Pflichtprüfungen, einmalige Erzeugung, Prüfsummen, Aufbewahrungsfrist,
 * Abrufprotokoll — und dass die Datenbank-Trigger (set-once) zu alledem
 * passen. Die echte Validierung (veraPDF, Mustang, KoSIT) ist Teil G.
 */

jest.setTimeout(120_000);

const PREFIX = newPrefix('e-rechnung');
const SOURCE = { ip: '203.0.113.9', userAgent: 'Jest-Integration' };
const actor = { userId: null, name: 'sam' };
// Eigenes Jahr, damit der global je Jahr laufende Nummernkreis nicht mit
// anderen Suiten kollidiert.
const YEAR = 2097;
const INVOICE_DATE = `${YEAR}-03-01`;

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
const prices = new PricingConfigService(env({}));
const issuer = new IssuerConfigService(env(ISSUER_ENV));
const service = new InvoiceService(prisma, audit, prices, issuer, env(ISSUER_ENV));

interface Call {
  html: string;
  xml: string;
  profile: CiiProfile | undefined;
}

/** Test-Double des Rechnungsdienstes: zeichnet auf, liefert ein Schein-PDF. */
function rendererDouble(): { renderer: InvoiceRenderer; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    renderer: {
      isConfigured: () => true,
      create: async (html, xml, profile) => {
        calls.push({ html, xml, profile });
        // Der Zähler macht jede Fassung verschieden — wie ein echter Dienst
        // mit Zeitstempel in den Metadaten.
        return Buffer.from(`%PDF-1.7 Schein-PDF Nr. ${calls.length}`, 'utf8');
      },
    },
  };
}

const sha = (data: Buffer | Uint8Array) =>
  createHash('sha256').update(data).digest('hex');

async function draft(
  label: string,
  company: Partial<Prisma.CompanyUncheckedCreateInput> = {},
  line: Partial<{
    taxRate: number;
    taxCategory: string;
    taxExemptionReason: string;
  }> = {},
) {
  const created = await createCompany(PREFIX, {
    street: 'Ziegelgasse',
    houseNumber: '14',
    postalCode: '99423',
    city: 'Weimar',
    country: 'DE',
    contactEmail: `${label}@example.com`,
    ...company,
  });
  const invoice = await service.draftCreate(
    created.id,
    {
      invoiceDate: INVOICE_DATE,
      servicePeriodFrom: INVOICE_DATE,
      servicePeriodUntil: datePlusDays(INVOICE_DATE, 364),
      lines: [
        {
          label: 'Jahresbeitrag, Stufe 2',
          quantity: 1,
          unitPriceNetCent: 38_500,
          taxRate: 19,
          ...line,
        },
      ],
    },
    actor,
    SOURCE,
  );
  return { companyId: created.id, invoiceId: invoice.id };
}

afterAll(async () => {
  await cleanUp(PREFIX);
  await disconnect();
});

describe('Aussteller-Härtung beim Festschreiben', () => {
  it('verweigert den Platzhalter-Aussteller und verbraucht keine Nummer', async () => {
    const created = await draft('platzhalter');
    const placeholderService = new InvoiceService(
      prisma,
      audit,
      prices,
      new IssuerConfigService(env({})), // keine Konfiguration = Platzhalter
      env(ISSUER_ENV),
    );
    await expect(
      placeholderService.finalize(created.invoiceId, actor, SOURCE),
    ).rejects.toBeInstanceOf(InvoiceIssuerPlaceholderError);
    const row = await prisma.invoice.findUniqueOrThrow({
      where: { id: created.invoiceId },
      select: { invoiceNumber: true, status: true, finalizedAt: true },
    });
    expect(row).toEqual({ invoiceNumber: null, status: 'draft', finalizedAt: null });
  });

  it('verlangt bei einer Behörde die Leitweg-ID', async () => {
    const created = await draft('behoerde-ohne', { buyerType: 'authority' });
    const error = await service
      .finalize(created.invoiceId, actor, SOURCE)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvoiceIncompleteError);
    expect(JSON.stringify((error as InvoiceIncompleteError).getResponse())).toContain(
      'Leitweg-ID',
    );

    await prisma.company.update({
      where: { id: created.companyId },
      data: { buyerReference: '991-12345-67' },
    });
    const done = await service.finalize(created.invoiceId, actor, SOURCE);
    expect(done.recipientBuyerType).toBe('authority');
    expect(done.recipientBuyerReference).toBe('991-12345-67');
  });
});

describe('Entwurf → Festschreiben → Dokumente', () => {
  it('setzt beim Festschreiben retentionUntil (Ende des Jahres + 8)', async () => {
    const created = await draft('aufbewahrung');
    const done = await service.finalize(created.invoiceId, actor, SOURCE);
    const finalizedYear = new Date(done.finalizedAt as string).getUTCFullYear();
    expect(done.retentionUntil).toBe(`${finalizedYear + 8}-12-31`);
    expect(retentionEnd(new Date('2026-05-04T10:00:00Z'), 8).toISOString().slice(0, 10)).toBe(
      '2034-12-31',
    );
  });

  it('erzeugt PDF, XML und XRechnung genau einmal, mit stimmenden Prüfsummen', async () => {
    const created = await draft('alle-drei', {
      buyerType: 'authority',
      buyerReference: '991-12345-67',
      electronicAddress: '991-12345-67',
      electronicAddressScheme: '0204',
      vatId: 'DE811111111',
    });
    const finalized = await service.finalize(created.invoiceId, actor, SOURCE);
    expect(finalized.documentPresent).toBe(false);
    expect(finalized.xrechnungPresent).toBe(false);
    expect(finalized.pdfSha256).toBeNull();

    const { renderer, calls } = rendererDouble();
    const documents = new InvoiceDocumentService(prisma, audit, issuer, renderer);

    // 1. XRechnung zuerst — unabhängig vom PDF.
    const xr1 = await documents.download('xrechnung', created.invoiceId, actor, SOURCE);
    expect(calls).toHaveLength(0);
    const xrText = xr1.content.toString('utf8');
    expect(xr1.contentType).toContain('application/xml');
    expect(xr1.filename).toMatch(/-xrechnung\.xml$/);
    expect(xrText).toContain(
      'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0',
    );
    expect(xrText).toContain('urn:fdc:peppol.eu:2017:poacc:billing:01:1.0');
    expect(xrText).toContain('<ram:BuyerReference>991-12345-67</ram:BuyerReference>');
    expect(xrText).toContain('schemeID="0204"');
    expect(xrText).toContain('<ram:ID schemeID="VA">DE811111111</ram:ID>');
    expect(xrText).toContain(
      `<ram:PaymentReference>${finalized.invoiceNumber}</ram:PaymentReference>`,
    );
    expect(xrText).toContain('DE89370400440532013000');

    // 2. Das PDF bettet GENAU die gespeicherten XML-Bytes ein (Profil EN16931).
    const pdf1 = await documents.download('pdf', created.invoiceId, actor, SOURCE);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.profile).toBe('EN16931');
    expect(calls[0]?.xml).not.toContain('xrechnung_3.0');
    const xml1 = await documents.download('xml', created.invoiceId, actor, SOURCE);
    expect(xml1.content.toString('utf8')).toBe(calls[0]?.xml);
    expect(pdf1.contentType).toBe('application/pdf');

    // 3. Jeder weitere Abruf liefert dieselben Bytes, ohne neu zu erzeugen.
    const pdf2 = await documents.download('pdf', created.invoiceId, actor, SOURCE);
    const xr2 = await documents.download('xrechnung', created.invoiceId, actor, SOURCE);
    const xml2 = await documents.download('xml', created.invoiceId, actor, SOURCE);
    expect(calls).toHaveLength(1);
    expect(pdf2.content.equals(pdf1.content)).toBe(true);
    expect(xr2.content.equals(xr1.content)).toBe(true);
    expect(xml2.content.equals(xml1.content)).toBe(true);

    // 4. Die Prüfsummen in der Datenbank stimmen mit den Bytes überein.
    const row = await prisma.invoice.findUniqueOrThrow({
      where: { id: created.invoiceId },
    });
    expect(row.pdfSha256).toBe(sha(pdf1.content));
    expect(row.xmlSha256).toBe(sha(xml1.content));
    expect(row.xrechnungSha256).toBe(sha(xr1.content));
    expect(sha(row.pdfContent as Uint8Array)).toBe(row.pdfSha256);
    expect(sha(row.xmlContent as Uint8Array)).toBe(row.xmlSha256);
    expect(sha(row.xrechnungContent as Uint8Array)).toBe(row.xrechnungSha256);
    expect(row.documentGeneratedAt).not.toBeNull();

    // 5. Antwort der API zeigt Dokumente und Prüfsummen.
    const response = await service.get(created.invoiceId);
    expect(response.documentPresent).toBe(true);
    expect(response.xrechnungPresent).toBe(true);
    expect(response.pdfSha256).toBe(row.pdfSha256);

    // 6. Audit: einmal erzeugt je Format, aber JEDER Abruf protokolliert.
    const entries = await prisma.auditLog.findMany({
      where: { objectId: created.invoiceId },
      orderBy: { timestamp: 'asc' },
    });
    const generated = entries
      .filter((e) => e.action === AUDIT_ACTION.invoiceDocumentGenerated)
      .map((e) => (e.afterValue as { format: string }).format)
      .sort();
    expect(generated).toEqual(['pdf', 'xml', 'xrechnung']);
    const downloaded = entries
      .filter((e) => e.action === 'invoice.document_downloaded')
      .map((e) => (e.afterValue as { format: string }).format);
    expect(downloaded).toEqual([
      'xrechnung',
      'pdf',
      'xml',
      'pdf',
      'xrechnung',
      'xml',
    ]);
    // Der Abruf trägt Herkunft und Akteur.
    expect(
      entries
        .filter((e) => e.action === 'invoice.document_downloaded')
        .every((e) => e.ip === SOURCE.ip && e.actor === actor.name),
    ).toBe(true);
  });

  it('erzeugt bei gleichzeitigen Abrufen genau eine XRechnung', async () => {
    const created = await draft('parallel');
    await service.finalize(created.invoiceId, actor, SOURCE);
    const { renderer } = rendererDouble();
    const documents = new InvoiceDocumentService(prisma, audit, issuer, renderer);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        documents.getXrechnung(created.invoiceId, actor, SOURCE),
      ),
    );
    expect(new Set(results.map((r) => r.xml.toString('utf8'))).size).toBe(1);
    const generated = await prisma.auditLog.count({
      where: {
        objectId: created.invoiceId,
        action: AUDIT_ACTION.invoiceDocumentGenerated,
      },
    });
    expect(generated).toBe(1);
  });

  it('friert die Darstellung beim Festschreiben ein: Profiländerung danach ändert PDF-HTML und XML nicht', async () => {
    const created = await draft('layout-freeze');
    const base = await issuer.current();
    // Mutable Attrappe: gibt zuerst das Profil von heute, später ein geändertes.
    let now: Awaited<ReturnType<typeof issuer.current>> = {
      ...base,
      accentColor: '#112233',
      logoDataUri: 'data:image/png;base64,AAAA',
    };
    const moving = new IssuerConfigService(env(ISSUER_ENV));
    moving.current = async () => now;
    const finalizing = new InvoiceService(prisma, audit, prices, moving, env(ISSUER_ENV));
    await finalizing.finalize(created.invoiceId, actor, SOURCE);

    now = {
      ...now,
      accentColor: '#AA0000',
      logoDataUri: null,
      profile: { ...now.profile, taxNumber: '99/999/99999', phone: '+49 1 2' },
    };
    const changedIssuer = documentIssuerFromCurrentForTest(now);
    expect(changedIssuer.blocks.legalLines.join('|')).toContain('99/999/99999');

    const first = rendererDouble();
    const documents = new InvoiceDocumentService(prisma, audit, moving, first.renderer);
    await documents.download('pdf', created.invoiceId, actor, SOURCE);
    const html = first.calls[0]!.html;
    expect(html).toContain('--acc:#112233');
    expect(html).toContain('data:image/png;base64,AAAA');
    expect(html).not.toContain('99/999/99999');
    expect(first.calls[0]!.xml).not.toContain('99/999/99999');
    expect(first.calls[0]!.xml).not.toContain('#AA0000');

    // Der gespeicherte Schnappschuss ist nach dem Festschreiben unveränderlich.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Invoice" SET "issuerLayout" = '{}'::jsonb WHERE "id" = '${created.invoiceId}'`,
      ),
    ).rejects.toThrow(/GoBD/);
  });

  it('schützt gespeicherte Dokumente per Trigger vor dem Überschreiben (set-once)', async () => {
    const created = await draft('trigger');
    await service.finalize(created.invoiceId, actor, SOURCE);
    const { renderer } = rendererDouble();
    const documents = new InvoiceDocumentService(prisma, audit, issuer, renderer);
    await documents.getXrechnung(created.invoiceId, actor, SOURCE);

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Invoice" SET "xrechnungContent" = '\\x00'::bytea WHERE "id" = '${created.invoiceId}'`,
      ),
    ).rejects.toThrow(/GoBD/);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Invoice" SET "xrechnungSha256" = 'x' WHERE "id" = '${created.invoiceId}'`,
      ),
    ).rejects.toThrow(/GoBD/);
  });

  it('weist für Lastschrift Code 59 samt Mandat aus; die Stornorechnung nie', async () => {
    const created = await draft('lastschrift', {
      paymentMethod: 'direct_debit',
      sepaMandateReference: 'MANDAT-0042',
    });
    const done = await service.finalize(created.invoiceId, actor, SOURCE);
    expect(done.paymentMeansCode).toBe('59');

    const { renderer } = rendererDouble();
    const documents = new InvoiceDocumentService(prisma, audit, issuer, renderer);
    const xr = (await documents.getXrechnung(created.invoiceId, actor, SOURCE)).xml.toString('utf8');
    expect(xr).toContain('<ram:TypeCode>59</ram:TypeCode>');
    expect(xr).toContain('<ram:DirectDebitMandateID>MANDAT-0042</ram:DirectDebitMandateID>');
    expect(xr).toContain('<ram:CreditorReferenceID>DE09ZZZ00000000001</ram:CreditorReferenceID>');

    const { cancellation } = await service.cancel(created.invoiceId, 'Tippfehler', actor, SOURCE);
    expect(cancellation.paymentMeansCode).toBe('58');
    expect(cancellation.recipientBuyerType).toBe('business');
    expect(cancellation.retentionUntil).not.toBeNull();
    const cancellationXml = (
      await documents.getXrechnung(cancellation.id, actor, SOURCE)
    ).xml.toString('utf8');
    expect(cancellationXml).toContain('<ram:TypeCode>58</ram:TypeCode>');
    expect(cancellationXml).not.toContain('DirectDebitMandateID');
  });

  it('übernimmt Steuerkategorie und Befreiungsgrund je Position in den Beleg', async () => {
    const created = await draft(
      'befreit',
      {},
      {
        taxRate: 0,
        taxCategory: 'E',
        taxExemptionReason: 'Steuerfrei nach § 4 Nr. 21 UStG',
      },
    );
    const done = await service.finalize(created.invoiceId, actor, SOURCE);
    expect(done.lines[0]?.taxCategory).toBe('E');
    expect(done.sumTax).toBe('0.00');
    const { renderer } = rendererDouble();
    const documents = new InvoiceDocumentService(prisma, audit, issuer, renderer);
    const xr = (await documents.getXrechnung(created.invoiceId, actor, SOURCE)).xml.toString('utf8');
    expect(xr).toContain('<ram:ExemptionReason>Steuerfrei nach § 4 Nr. 21 UStG</ram:ExemptionReason>');
    expect(xr).toContain('<ram:CategoryCode>E</ram:CategoryCode>');
  });

  it('weist ungültige Steuerkategorien schon beim Entwurf ab', async () => {
    await expect(draft('s-null', {}, { taxRate: 0 })).rejects.toBeInstanceOf(InvoiceIncompleteError);
    await expect(
      draft('e-ohne-grund', {}, { taxRate: 0, taxCategory: 'E' }),
    ).rejects.toBeInstanceOf(InvoiceIncompleteError);
    await expect(
      draft('z-mit-satz', {}, { taxRate: 19, taxCategory: 'Z' }),
    ).rejects.toBeInstanceOf(InvoiceIncompleteError);
  });

  it('verweigert die XRechnung ohne Käufer-USt-IdNr. bei Reverse Charge mit klarer Meldung', async () => {
    const created = await draft(
      'ae-ohne-ustid',
      {},
      { taxRate: 0, taxCategory: 'AE' },
    );
    await service.finalize(created.invoiceId, actor, SOURCE);
    const { renderer } = rendererDouble();
    const documents = new InvoiceDocumentService(prisma, audit, issuer, renderer);
    await expect(
      documents.getXrechnung(created.invoiceId, actor, SOURCE),
    ).rejects.toThrow(/BT-48/);
    const row = await prisma.invoice.findUniqueOrThrow({
      where: { id: created.invoiceId },
      select: { xrechnungContent: true },
    });
    expect(row.xrechnungContent).toBeNull();
  });
});
