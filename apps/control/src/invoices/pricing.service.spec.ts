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

function service(company: {
  priceTier: string | null;
  paymentInterval: 'yearly' | 'half_yearly' | 'monthly' | null;
}): PricingService {
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
