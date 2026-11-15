import { ConfigService } from '@nestjs/config';
import {
  PRICE_TABLE_VARIABLE,
  PRICE_PRESETS,
  PricingConfigService,
  issues,
} from './pricing.config';
import { averageActivePersons, tierFor } from './pricing.tier';
import { PriceConfigurationInvalidError } from './invoice.errors';
import type { PriceTable } from './pricing.types';

function configWith(value?: string): PricingConfigService {
  const config = {
    get: (name: string) => (name === PRICE_TABLE_VARIABLE ? value : undefined),
  } as unknown as ConfigService;
  return new PricingConfigService(config);
}

function tableWith(change: Partial<PriceTable>): PriceTable {
  return { ...PRICE_PRESETS, ...change };
}

describe('Preistafel — die neutralen Vorgaben', () => {
  it('führt Stufen bis 10, bis 30 und nach oben offen', () => {
    expect(PRICE_PRESETS.tiers.map((s) => s.maxPersons)).toEqual([10, 30, null]);
  });

  it('nennt monatlich 10, 20 und 30 € netto', () => {
    expect(PRICE_PRESETS.tiers.map((s) => s.monthlyCent)).toEqual([
      1_000, 2_000, 3_000,
    ]);
  });

  it('nennt halbjährlich 59, 119 und 179 € netto', () => {
    expect(PRICE_PRESETS.tiers.map((s) => s.halfYearlyCent)).toEqual([
      5_900, 11_900, 17_900,
    ]);
  });

  it('nennt die Einrichtung mit 50 € netto — in jeder Stufe dieselbe', () => {
    // Die Zahlen der Vorgaben sind Platzhalter. Dass Webseite/Manifest und
    // Preistafel dieselben Preise nennen, prüft `pricing-manifest.spec.ts`.
    expect(PRICE_PRESETS.tiers.map((s) => s.setupCent)).toEqual([
      5_000, 5_000, 5_000,
    ]);
  });

  /**
   * DER JAHRESPREIS IST DEFINIERT ALS ELF MONATSRATEN.
   *
   * Der Test steht hier nicht wegen der Schönheit der Zahl, sondern damit eine
   * spätere Preisänderung nicht versehentlich nur eine der beiden anfasst. Wer
   * den Monatspreis anhebt und den Jahrespreis vergisst, verschenkt still den
   * Unterschied — auf jeder Jahresrechnung, jahrelang.
   */
  it('rechnet den Jahrespreis als elf Monatsraten', () => {
    for (const tier of PRICE_PRESETS.tiers) {
      expect(tier.yearlyCent).toBe(tier.monthlyCent * 11);
    }
  });

  it('bildet den Durchschnitt über 90 Tage', () => {
    expect(PRICE_PRESETS.averageDays).toBe(90);
  });
});

describe('beanstandungen', () => {
  it('lässt die Vorgaben durch', () => {
    expect(issues(PRICE_PRESETS)).toEqual([]);
  });

  it('verlangt genau eine nach oben offene Stufe', () => {
    const two = tableWith({
      tiers: PRICE_PRESETS.tiers.map((s) => ({ ...s, maxPersons: null })),
    });
    expect(issues(two).join(' ')).toContain('nach oben offen');
  });

  it('verlangt, dass die offene Stufe die letzte ist', () => {
    const swapped = tableWith({
      tiers: [...PRICE_PRESETS.tiers].reverse(),
    });
    expect(issues(swapped).join(' ')).toContain('muss die letzte sein');
  });

  it('verlangt streng steigende Schwellen', () => {
    const [first, second, third] = PRICE_PRESETS.tiers;
    const same = tableWith({
      tiers: [
        { ...(first as (typeof PRICE_PRESETS.tiers)[number]), maxPersons: 30 },
        second as (typeof PRICE_PRESETS.tiers)[number],
        third as (typeof PRICE_PRESETS.tiers)[number],
      ],
    });
    expect(issues(same).join(' ')).toContain('streng steigen');
  });

  it('weist Beträge ab, die keine ganzen Cent sind', () => {
    const [first, ...rest] = PRICE_PRESETS.tiers;
    const malformed = tableWith({
      tiers: [
        {
          ...(first as (typeof PRICE_PRESETS.tiers)[number]),
          monthlyCent: 19.99,
        },
        ...rest,
      ],
    });
    expect(issues(malformed).join(' ')).toContain('ganze Zahl in Cent');
  });

  it('weist doppelte Schlüssel ab', () => {
    const [first, second, third] = PRICE_PRESETS.tiers;
    const twice = tableWith({
      tiers: [
        first as (typeof PRICE_PRESETS.tiers)[number],
        {
          ...(second as (typeof PRICE_PRESETS.tiers)[number]),
          key: 'stufe1',
        },
        third as (typeof PRICE_PRESETS.tiers)[number],
      ],
    });
    expect(issues(twice).join(' ')).toContain('doppelt');
  });
});

describe('PricingConfigService', () => {
  it('nimmt ohne Umgebungsvariable die Vorgaben', () => {
    expect(configWith(undefined).read()).toBe(PRICE_PRESETS);
  });

  it('übernimmt eine gültige Tafel aus der Umgebung', () => {
    const own = configWith(
      JSON.stringify({
        tiers: [
          {
            key: 'pauschal',
            label: 'Pauschal',
            maxPersons: null,
            monthlyCent: 1000,
            halfYearlyCent: 5_500,
            yearlyCent: 11_000,
            setupCent: 0,
          },
        ],
      }),
    ).read();
    expect(own.tiers).toHaveLength(1);
    // Nicht genannte Felder behalten die Vorgabe.
    expect(own.taxRate).toBe(19);
    expect(own.averageDays).toBe(90);
  });

  /**
   * EINE KAPUTTE PREISTAFEL DARF NICHT STILL AUF DIE VORGABEN ZURÜCKFALLEN.
   *
   * Das ist der Unterschied zum `CoolifyConfigService`, der bei fehlendem
   * Token warnt und weiterläuft: Dort ist die Folge eine sichtbar
   * unbenutzbare Instanzverwaltung. Hier wäre die Folge eine Rechnung mit
   * einem anderen Betrag als vereinbart — und die fällt erst auf, wenn die
   * Kundin anruft.
   */
  it('wirft bei fehlerhaftem JSON statt still zurückzufallen', () => {
    expect(() => configWith('{kein json').read()).toThrow(
      PriceConfigurationInvalidError,
    );
  });

  it('wirft bei einer inhaltlich unbrauchbaren Tafel', () => {
    const broken = JSON.stringify({
      tiers: [
        {
          key: 'a',
          label: 'A',
          maxPersons: 10,
          monthlyCent: 100,
          yearlyCent: 1100,
          setupCent: 0,
        },
      ],
    });
    // Keine nach oben offene Stufe: 11 Personen hätten keine Zuordnung.
    expect(() => configWith(broken).read()).toThrow(
      PriceConfigurationInvalidError,
    );
  });

  it('bricht beim Start ab, wenn die Tafel unbrauchbar ist', () => {
    expect(() => configWith('[]').onModuleInit()).toThrow(
      PriceConfigurationInvalidError,
    );
  });

  it('findet eine Stufe über ihren Schlüssel', () => {
    expect(configWith(undefined).tier('stufe2')?.monthlyCent).toBe(2_000);
    expect(configWith(undefined).tier('gibtsnicht')).toBeNull();
    expect(configWith(undefined).tier(null)).toBeNull();
  });
});

describe('tierFor — die Schwellen', () => {
  const tiers = PRICE_PRESETS.tiers;

  it.each([
    [1, 'stufe1'],
    [10, 'stufe1'],
    [11, 'stufe2'],
    [30, 'stufe2'],
    [31, 'stufe3'],
    [500, 'stufe3'],
  ])('ordnet %i aktive Personen der %s zu', (persons, expected) => {
    expect(tierFor(persons, tiers)?.key).toBe(expected);
  });

  /**
   * DER DURCHSCHNITT WIRD VOR DEM VERGLEICH GERUNDET.
   *
   * Ohne das fiele ein Durchschnitt von 10,4 in Stufe 2, obwohl an keinem
   * einzigen Tag mehr als zehn Personen aktiv waren.
   */
  it('rundet den Durchschnitt kaufmännisch, bevor es vergleicht', () => {
    expect(tierFor(10.4, tiers)?.key).toBe('stufe1');
    expect(tierFor(10.5, tiers)?.key).toBe('stufe2');
    expect(tierFor(30.49, tiers)?.key).toBe('stufe2');
    expect(tierFor(30.5, tiers)?.key).toBe('stufe3');
  });
});

describe('averageActivePersons', () => {
  it('mittelt über die gelieferten Werte', () => {
    expect(averageActivePersons([10, 20, 30])).toEqual({
      average: 20,
      measurementDays: 3,
    });
  });

  /**
   * FEHLGESCHLAGENE ABFRAGEN ZÄHLEN NICHT ALS NULL.
   *
   * `Kennzahl.aktivePersonen` ist seit Etappe 3 nullbar, weil eine
   * fehlgeschlagene Abfrage keine Zahlen hat. Zöge man sie als 0 in den
   * Durchschnitt, wäre eine Woche Netzstörung beim Kunden ein Rabatt.
   */
  it('übergeht Tage ohne Messung, statt sie als 0 zu zählen', () => {
    expect(averageActivePersons([30, null, null, 30])).toEqual({
      average: 30,
      measurementDays: 2,
    });
    // Zum Vergleich: Als Nullen gezählt ergäbe dasselbe 15 — und damit eine
    // Stufe zu niedrig.
    expect(tierFor(30, PRICE_PRESETS.tiers)?.key).toBe('stufe2');
    expect(tierFor(15, PRICE_PRESETS.tiers)?.key).toBe('stufe2');
  });

  it('liefert null, wenn es keine einzige Messung gab', () => {
    expect(averageActivePersons([null, null])).toEqual({
      average: null,
      measurementDays: 0,
    });
    expect(averageActivePersons([])).toEqual({
      average: null,
      measurementDays: 0,
    });
  });
});
