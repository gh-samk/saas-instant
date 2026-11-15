import { toDate } from '@saas-instant/shared';
import type { PrismaService } from '../../prisma/prisma.service';
import { PRICE_PRESETS } from '../../invoices/pricing.config';
import type { TasksContext } from '../tasks.types';
import { tierCheck } from './tier-check.source';

/**
 * Die Quelle „Stufe prüfen".
 *
 * Die Vorgaben des Auftrags: bis 10 / 11–30 / ab 31 aktive Personen. Geprüft
 * wird an den Schwellen selbst, in beide Richtungen — und daran, dass
 * gescheiterte Abfragen den Durchschnitt nicht nach unten ziehen.
 */

const Today = '2026-09-01';
const Tiers = PRICE_PRESETS.tiers;

function company(priceTier: string) {
  return {
    id: 'o1',
    name: 'Kollektiv Grünspecht e. V.',
    status: 'paying',
    priceTier,
    instance: { id: 'i1' },
  };
}

function contextWith(
  companies: unknown[],
  measurements: { day: string; activePersons: number | null }[],
): TasksContext {
  const prisma = {
    company: { findMany: () => Promise.resolve(companies) },
    metric: {
      findMany: () =>
        Promise.resolve(
          measurements.map((m) => ({
            instanceId: 'i1',
            date: toDate(m.day),
            activePersons: m.activePersons,
          })),
        ),
    },
  } as unknown as PrismaService;

  return {
    prisma,
    todayDay: Today,
    now: new Date(`${Today}T08:00:00Z`),
    since: '2026-08-25',
    limit: 25,
    priceTable: PRICE_PRESETS,
    outbox: [],
  };
}

/** Gleiche Zahl an aufeinanderfolgenden Tagen. */
function constant(value: number, days: number) {
  return Array.from({ length: days }, (_, i) => ({
    day: `2026-08-${String(i + 1).padStart(2, '0')}`,
    activePersons: value,
  }));
}

describe('stufePruefen — die Schwellen', () => {
  it('schweigt, wenn die gemessene Größe zur vereinbarten Stufe passt', async () => {
    const { tasks, total } = await tierCheck.collect(
      contextWith([company(Tiers[0].key)], constant(8, 10)),
    );
    expect(tasks).toEqual([]);
    expect(total).toBe(0);
  });

  it('meldet, wenn die Instanz über die vereinbarte Stufe gewachsen ist', async () => {
    const { tasks } = await tierCheck.collect(
      contextWith([company(Tiers[0].key)], constant(24, 10)),
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].reason).toContain('gewachsen');
    expect(tasks[0].action.kind).toBe('price_agree');
  });

  it('MELDET AUCH DIE GEGENRICHTUNG — wer geschrumpft ist, zahlt zu viel', async () => {
    const { tasks } = await tierCheck.collect(
      contextWith([company(Tiers[2].key)], constant(9, 10)),
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].reason).toContain('zahlt');
    expect(tasks[0].reason).toContain('zu viel');
  });

  it('behandelt die obere Schwelle EINSCHLIESSLICH: 10 ist noch Stufe 1', async () => {
    const { tasks } = await tierCheck.collect(
      contextWith([company(Tiers[0].key)], constant(10, 10)),
    );
    expect(tasks).toEqual([]);
  });

  it('und 11 ist es nicht mehr', async () => {
    const { tasks } = await tierCheck.collect(
      contextWith([company(Tiers[0].key)], constant(11, 10)),
    );
    expect(tasks).toHaveLength(1);
  });
});

describe('stufePruefen — die Grundlage der Aussage', () => {
  it('nennt Durchschnitt, Messtage und Zeitraum, nicht nur das Ergebnis', async () => {
    const { tasks } = await tierCheck.collect(
      contextWith([company(Tiers[0].key)], constant(20, 7)),
    );
    expect(tasks[0].reason).toContain('20');
    expect(tasks[0].reason).toContain('7 von 90 Tagen');
  });

  it('ZÄHLT GESCHEITERTE ABFRAGEN NICHT ALS NULL — sonst wäre eine Netzstörung ein Rabatt', async () => {
    // Fünf echte Messungen zu 24 Personen, dazu fünf Zeilen ohne Zahl. Als 0
    // gezaehlt ergaebe das einen Durchschnitt von 12 und damit dieselbe Stufe
    // wie ohne Stoerung — die Abweichung fiele unter den Tisch.
    const measurements = [
      ...constant(24, 5),
      ...Array.from({ length: 5 }, (_, i) => ({
        day: `2026-08-${String(i + 6).padStart(2, '0')}`,
        activePersons: null,
      })),
    ];
    const { tasks } = await tierCheck.collect(
      contextWith([company(Tiers[0].key)], measurements),
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].reason).toContain('5 von 90 Tagen');
  });

  it('schweigt ohne jede Messung — eine Aussage ohne Grundlage wäre geraten', async () => {
    const { tasks } = await tierCheck.collect(
      contextWith([company(Tiers[0].key)], []),
    );
    expect(tasks).toEqual([]);
  });

  it('schweigt bei einer Stufe, die es in der Preistafel nicht mehr gibt', async () => {
    const { tasks } = await tierCheck.collect(
      contextWith([company('entfallene-tier')], constant(24, 10)),
    );
    expect(tasks).toEqual([]);
  });
});

describe('stufePruefen — wen sie gar nicht erst betrachtet', () => {
  it('übergeht Organisationen mit ausgehandeltem Betrag', async () => {
    let seen: Record<string, unknown> | undefined;
    const prisma = {
      company: {
        findMany: (args: { where: Record<string, unknown> }) => {
          seen = args.where;
          return Promise.resolve([]);
        },
      },
    } as unknown as PrismaService;

    await tierCheck.collect({ ...contextWith([], []), prisma });

    expect(seen).toMatchObject({
      status: 'paying',
      priceTier: { not: null },
      // Ein ausgehandelter Preis hat die Stufe bewusst verlassen. Ihn an der
      // Schwelle zu messen hiesse, eine Vereinbarung anzuzweifeln.
      customAmount: null,
    });
  });

  it('ändert nichts — die Quelle kennt keinen Schreibvorgang', async () => {
    const written: string[] = [];
    const allowed = new Set(['company', 'metric']);
    const prisma = new Proxy(
      {
        company: { findMany: () => Promise.resolve([]) },
        metric: { findMany: () => Promise.resolve([]) },
      } as Record<string, unknown>,
      {
        get(target, name: string) {
          if (allowed.has(name)) return target[name];
          written.push(name);
          return {};
        },
      },
    ) as unknown as PrismaService;

    await tierCheck.collect({ ...contextWith([], []), prisma });
    expect(written).toEqual([]);
  });
});
