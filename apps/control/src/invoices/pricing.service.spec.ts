import { PricingService } from './pricing.service';
import { PRICE_PRESETS, type PricingConfigService } from './pricing.config';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Der Vertrag der Organisation im Stufenvorschlag.
 *
 * Der Dienst liest die Preisstufe und die Zahlungsweise von der Organisation
 * und löst die Stufe gegen die Preisliste auf — er schreibt nichts (R5). Die
 * Oberfläche bietet daraus „Posten aus Vertrag übernehmen" an; ohne Stufe
 * muss sie wissen, dass es keinen Preis gibt, den sie anbieten dürfte.
 */

function service(
  company: {
    priceTier: string | null;
    paymentInterval: 'yearly' | 'half_yearly' | 'monthly' | null;
  },
  setupLines = 0,
): PricingService {
  const prisma = {
    company: {
      findUnique: async () => ({
        customAmount: null,
        instanceStartDate: null,
        instance: null,
        ...company,
      }),
    },
    metric: { findMany: async () => [] },
    invoiceLine: { count: async () => setupLines },
  } as unknown as PrismaService;
  const config = {
    read: () => PRICE_PRESETS,
    tier: (key: string | null) =>
      PRICE_PRESETS.tiers.find((s) => s.key === key) ?? null,
  } as unknown as PricingConfigService;
  return new PricingService(prisma, config);
}

describe('Stufenvorschlag: Vertrag der Organisation', () => {
  it('löst die hinterlegte Stufe samt Zahlungsweise gegen die Preisliste auf', async () => {
    const result = await service({
      priceTier: 'stufe2',
      paymentInterval: 'half_yearly',
    }).suggestion('c1', '2026-08-17');
    expect(result.contract.tierKey).toBe('stufe2');
    expect(result.contract.tier?.halfYearlyCent).toBe(11_900);
    expect(result.contract.paymentInterval).toBe('half_yearly');
  });

  it('liefert ohne Preisstufe weder Schlüssel noch Preise', async () => {
    const result = await service({
      priceTier: null,
      paymentInterval: 'monthly',
    }).suggestion('c1', '2026-08-17');
    expect(result.contract.tierKey).toBeNull();
    expect(result.contract.tier).toBeNull();
  });

  it('behält einen unbekannten Schlüssel, bietet aber keinen Preis an', async () => {
    const result = await service({
      priceTier: 'frei-getippt',
      paymentInterval: null,
    }).suggestion('c1', '2026-08-17');
    expect(result.contract.tierKey).toBe('frei-getippt');
    expect(result.contract.tier).toBeNull();
    expect(result.contract.paymentInterval).toBeNull();
  });
});

describe('Stufenvorschlag: Einrichtung nur einmal [N8f]', () => {
  const contract = { priceTier: 'stufe2', paymentInterval: 'yearly' as const };

  it('schlägt die Einrichtung vor, solange noch keine berechnet wurde', async () => {
    const result = await service(contract, 0).suggestion('c1', '2026-08-17');
    expect(result.setupCalculable).toBe(true);
    expect(result.setupInvoiced).toBe(false);
  });

  it('schlägt sie nicht mehr vor, sobald ein Einrichtungsposten festgeschrieben ist', async () => {
    const result = await service(contract, 1).suggestion('c1', '2026-08-17');
    expect(result.setupCalculable).toBe(false);
    expect(result.setupInvoiced).toBe(true);
  });

  it('zählt nur festgeschriebene, nicht stornierte Rechnungen der Organisation', async () => {
    let seen: unknown;
    const prisma = {
      company: {
        findUnique: async () => ({
          customAmount: null,
          instanceStartDate: null,
          instance: null,
          ...contract,
        }),
      },
      metric: { findMany: async () => [] },
      invoiceLine: {
        count: async (args: unknown) => {
          seen = args;
          return 0;
        },
      },
    } as unknown as PrismaService;
    const config = {
      read: () => PRICE_PRESETS,
      tier: () => null,
    } as unknown as PricingConfigService;
    await new PricingService(prisma, config).suggestion('c1', '2026-08-17');
    expect(seen).toMatchObject({
      where: {
        label: { startsWith: 'Einrichtung' },
        invoice: {
          companyId: 'c1',
          finalizedAt: { not: null },
          status: { not: 'cancelled' },
          cancelledInvoiceId: null,
        },
      },
    });
  });
});
