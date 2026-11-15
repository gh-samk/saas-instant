import type { ConfigService } from '@nestjs/config';
import { datePlusDays, today } from '@saas-instant/shared';
import { AuditService } from '../audit/audit.service';
import { CompanyService } from '../companies/company.service';
import {
  cleanUp,
  createCompany,
  disconnect,
  newPrefix,
  prisma,
  sendDouble,
} from '../test-support/company-provisioning';
import { IssuerConfigService } from './document/issuer.config';
import { PriceTierUnknownError } from './invoice.errors';
import { InvoiceService } from './invoice.service';
import { PricingConfigService } from './pricing.config';

/**
 * Posten mit Stufenbezug und die Prüfung von `Company.priceTier` gegen die
 * aktiven Stufen der Preisliste (Teil B).
 */

jest.setTimeout(60_000);

const PREFIX = newPrefix('preisstufe');
const SOURCE = { ip: '203.0.113.7', userAgent: 'Jest-Integration' };
const actor = { userId: null, name: 'sam' };
const emptyEnvironment = { get: () => undefined } as unknown as ConfigService;

const prices = new PricingConfigService(emptyEnvironment, undefined, prisma);
const audit = new AuditService(prisma);
const invoices = new InvoiceService(
  prisma,
  audit,
  prices,
  new IssuerConfigService(emptyEnvironment),
  emptyEnvironment,
);
const companies = new CompanyService(prisma, audit, sendDouble(), prices);

beforeAll(async () => {
  await prisma.priceTier.deleteMany();
  await prisma.priceList.deleteMany();
  await prices.onModuleInit();
});

afterAll(async () => {
  await cleanUp(PREFIX);
  await disconnect();
});

function draftOf(
  lines: { priceTierKey?: string; priceTierLabel?: string }[],
) {
  const day = datePlusDays(today(), -5);
  return {
    invoiceDate: day,
    servicePeriodFrom: day,
    servicePeriodUntil: datePlusDays(day, 30),
    lines: lines.map((p) => ({
      label: 'Posten',
      quantity: 1,
      unitPriceNetCent: 1000,
      taxRate: 19,
      ...p,
    })),
  };
}

describe('Posten mit Stufenbezug', () => {
  it('speichert Schlüssel und Etikett aus der Preisliste, nicht vom Client', async () => {
    const company = await createCompany(PREFIX, { street: 'A', houseNumber: '1', postalCode: '99423', city: 'Weimar', country: 'Deutschland' });
    const tier = prices.read().tiers[0]!;
    const invoice = await invoices.draftCreate(
      company.id,
      draftOf([{ priceTierKey: tier.key, priceTierLabel: 'frei erfunden' }, {}]),
      actor,
      SOURCE,
    );
    expect(invoice.lines[0]).toMatchObject({ priceTierKey: tier.key, priceTierLabel: tier.label });
    expect(invoice.lines[1]).toMatchObject({ priceTierKey: null, priceTierLabel: null });
  });

  it('weist eine unbekannte Stufe ab', async () => {
    const company = await createCompany(PREFIX, { street: 'A', houseNumber: '1', postalCode: '99423', city: 'Weimar', country: 'Deutschland' });
    await expect(
      invoices.draftCreate(company.id, draftOf([{ priceTierKey: 'gibt-es-nicht' }]), actor, SOURCE),
    ).rejects.toBeInstanceOf(PriceTierUnknownError);
  });
});

describe('Company.priceTier gegen aktive Stufen', () => {
  it('nimmt eine aktive Stufe an, lehnt eine unbekannte beim Setzen ab', async () => {
    const company = await createCompany(PREFIX);
    const key = prices.read().tiers[0]!.key;
    const ok = await companies.update(company.id, { priceTier: key }, actor, SOURCE);
    expect(ok.priceTier).toBe(key);
    await expect(
      companies.update(company.id, { priceTier: 'frei-erfunden' }, actor, SOURCE),
    ).rejects.toBeInstanceOf(PriceTierUnknownError);
  });

  it('toleriert Altwerte: ein unveränderter freier Wert bleibt, auch bei anderen Änderungen', async () => {
    const company = await createCompany(PREFIX, { priceTier: 'Standard' });
    const result = await companies.update(
      company.id,
      { priceTier: 'Standard', city: 'Erfurt' },
      actor,
      SOURCE,
    );
    expect(result.priceTier).toBe('Standard');
    // Leeren ist immer erlaubt.
    const cleared = await companies.update(company.id, { priceTier: '' }, actor, SOURCE);
    expect(cleared.priceTier === '' || cleared.priceTier === null).toBe(true);
  });
});
