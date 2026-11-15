import { join } from 'node:path';
import { loadManifest } from '../manifest/manifest.loader';
import {
  issues,
  PRICE_PRESETS,
  PricingConfigService,
  priceTableFromManifest,
} from './pricing.config';
import type { ConfigService } from '@nestjs/config';
import type { ManifestService } from '../manifest/manifest.service';

/**
 * ===========================================================================
 * DIE PREISE DES MANIFESTS UND DIE DER PREISTAFEL MÜSSEN DIESELBEN SEIN
 * ===========================================================================
 *
 * Früher legte dieser Test die Preise einer öffentlichen Webseite neben die
 * Preistafel des Backends. Die Preise stehen jetzt im Manifest
 * (`billing.tiers`) — der einen Quelle, die der Betreiber pflegt. Der Test
 * stellt sicher, dass die Preistafel genau das liefert, was dort steht, und
 * dass abgeleitete Preise (Halbjahr, Jahr) die Staffelung einhalten.
 */

const EXAMPLE = join(__dirname, '..', '..', '..', '..', 'saas-instant.manifest.example.yaml');

const emptyEnvironment = { get: () => undefined } as unknown as ConfigService;

function manifestService(): ManifestService {
  return { billing: loadManifest(EXAMPLE).manifest.billing } as unknown as ManifestService;
}

describe('Preistafel gegen das Manifest', () => {
  const billing = loadManifest(EXAMPLE).manifest.billing;

  it('findet überhaupt Stufen im Beispielmanifest (sonst prüft der Test nichts)', () => {
    expect(billing.tiers.length).toBeGreaterThan(0);
    expect(priceTableFromManifest(billing)).not.toBeNull();
  });

  it('übernimmt Stufen, Schwellen und Monatspreise unverändert', () => {
    const table = new PricingConfigService(emptyEnvironment, manifestService()).read();
    expect(table.tiers).toHaveLength(billing.tiers.length);
    billing.tiers.forEach((t, i) => {
      const tier = table.tiers[i]!;
      expect(tier.key).toBe(t.key);
      expect(tier.label).toBe(t.label);
      expect(tier.maxPersons).toBe(t.maxPersons);
      expect(tier.monthlyCent).toBe(t.monthlyCents ?? t.priceCents);
    });
  });

  it('liefert eine in sich gültige Tafel', () => {
    expect(issues(priceTableFromManifest(billing)!)).toEqual([]);
  });

  it('leitet Halbjahr und Jahr aus dem Monatspreis ab, wenn sie fehlen', () => {
    const table = priceTableFromManifest({
      ...billing,
      tiers: [
        {
          key: 'x',
          label: 'X',
          priceCents: 1_000,
          maxPersons: null,
          monthlyCents: null,
          halfYearlyCents: null,
          yearlyCents: null,
          setupCents: null,
        },
      ],
    })!;
    expect(table.tiers[0]).toMatchObject({
      monthlyCent: 1_000,
      halfYearlyCent: 5_500,
      yearlyCent: 11_000,
      setupCent: 0,
    });
  });

  it('ohne Stufen im Manifest gelten die neutralen Vorgaben', () => {
    const renderer = { billing: { ...billing, tiers: [] } } as unknown as ManifestService;
    expect(new PricingConfigService(emptyEnvironment, renderer).read()).toBe(PRICE_PRESETS);
  });

  it('die Umgebung geht dem Manifest vor', () => {
    const config = {
      get: (n: string) =>
        n === 'CONTROL_PRICE_TABLE'
          ? JSON.stringify({ tiers: PRICE_PRESETS.tiers })
          : undefined,
    } as unknown as ConfigService;
    const table = new PricingConfigService(config, manifestService()).read();
    expect(table.tiers.map((s) => s.key)).toEqual(
      PRICE_PRESETS.tiers.map((s) => s.key),
    );
  });

  it('hält die Staffelung der neutralen Vorgaben ein: seltener zahlen ist günstiger', () => {
    // Ein Halbjahrespreis über sechs Monatsraten wäre ein Rechenfehler, den
    // niemand bemerkt.
    for (const tier of PRICE_PRESETS.tiers) {
      expect(tier.halfYearlyCent).toBeLessThan(tier.monthlyCent * 6);
      expect(tier.yearlyCent).toBeLessThan(tier.monthlyCent * 12);
      expect(tier.yearlyCent).toBeLessThan(tier.halfYearlyCent * 2);
    }
  });
});
