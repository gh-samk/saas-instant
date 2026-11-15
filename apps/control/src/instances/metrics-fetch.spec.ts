import { today } from '@saas-instant/shared';
import { CONTRACT_PRESET } from '../coolify/coolify.config';
import {
  APP_VERSION_PATTERN,
  INT4_MAX,
  MetricsFetchService,
  getViaHttp,
  nameAbdruck,
  isMetricsResponse,
  isCountValue,
  type MetricsFetch,
} from './metrics-fetch.service';

const TOKEN_PLAIN = 'geheimer-kennzahlen-token';
const TOKEN_ENCRYPTED = 'iv.tag.chiffre';

interface Row {
  id: string;
  subdomain: string;
  metricsTokenEncrypted: string | null;
  company: { name: string };
}

function build(
  instances: Row[],
  fetch: MetricsFetch,
  contract: Record<string, unknown> = {},
) {
  const upserts: unknown[] = [];
  const instanceUpdates: unknown[] = [];
  const prisma = {
    instance: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue(instances),
      update: jest.fn().mockImplementation((arg: unknown) => {
        instanceUpdates.push(arg);
        return Promise.resolve({});
      }),
    },
    metric: {
      upsert: jest.fn().mockImplementation((arg: unknown) => {
        upserts.push(arg);
        return Promise.resolve({});
      }),
    },
  };
  const auditRows: unknown[] = [];
  const audit = {
    log: jest.fn().mockImplementation((e: unknown) => {
      auditRows.push(e);
      return Promise.resolve();
    }),
  };
  const crypto = {
    decrypt: jest.fn().mockImplementation((value: string) => {
      if (value !== TOKEN_ENCRYPTED) throw new Error('nicht lesbar');
      return TOKEN_PLAIN;
    }),
  };
  const config = { get: (_k: string, d?: string) => d };
  const coolifyConfig = {
    contract: () => ({ ...CONTRACT_PRESET, baseDomain: 'example.com', ...contract }),
  };
  const service = new MetricsFetchService(
    prisma as never,
    audit as never,
    crypto as never,
    config as never,
    coolifyConfig as never,
    fetch,
  );
  return { service, upserts, instanceUpdates, auditRows, prisma };
}

const GOOD_RESPONSE = {
  datenbank: 'erreichbar' as const,
  aktivePersonen: 34,
  kreise: 6,
  letzterEintragAm: '2026-08-19',
  letzteAnmeldungAm: '2026-08-28',
  appVersion: '0.5.2',
  organisationsnameStimmt: true,
};

const ONE: Row[] = [
  { id: 'i1', subdomain: 'musterverein', metricsTokenEncrypted: TOKEN_ENCRYPTED, company: { name: 'Musterverein Ostend e. V.' } },
];

describe('Kennzahlen-Abruf — der Pfad ist im Instanz-Vertrag optional', () => {
  it('überspringt alle Instanzen sauber, wenn die Software keinen metrics-Pfad deklariert', async () => {
    const fetch = jest.fn();
    const { service, upserts, auditRows, prisma } = build(ONE, fetch as never, { metricsPath: null });

    const result = await service.executeFrom({ actor: 'test', userId: null });

    // Kein Abruf, keine Zeile (auch keine Fehlzeile), kein Eintrag, kein Wurf.
    expect(result).toEqual({ day: today(), fetched: 0, successful: 0, failed: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect(prisma.instance.findMany).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });

  it('der Knopf „jetzt abrufen" fragt dann ebenfalls nicht (null = nichts zu fragen)', async () => {
    const fetch = jest.fn();
    const { service, upserts } = build(ONE, fetch as never, { metricsPath: null });
    (service as unknown as { prisma: { instance: { findFirst: jest.Mock } } }).prisma.instance.findFirst.mockResolvedValue(ONE[0]);

    await expect(service.executeFromFor('o1', { actor: 'test', userId: null })).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(0);
  });

  it('nimmt den deklarierten Pfad und das Hostmuster des Manifests', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: true, values: GOOD_RESPONSE });
    const { service } = build(ONE, fetch as never, {
      metricsPath: '/intern/zahlen',
      subdomainPattern: 'app-{slug}.{base}',
    });
    await service.executeFrom({ actor: 'test', userId: null });
    expect((fetch.mock.calls[0] as string[])[0]).toMatch(
      /^https:\/\/app-musterverein\.example\.com\/intern\/zahlen\?/,
    );
  });
});

describe('Kennzahlen-Abruf — Pull, nicht Push', () => {
  it('fragt jede aktive Instanz über HTTPS ab und speichert die Werte', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: true, values: GOOD_RESPONSE });
    const { service, upserts } = build(ONE, fetch as never);

    const result = await service.executeFrom({ actor: 'test', userId: null });

    expect(fetch).toHaveBeenCalledWith(
      // Der ABDRUCK des erwarteten Namens hängt an der Adresse, nie der Name
      // selbst ([W3]).
      `https://musterverein.example.com/api/intern/kennzahlen?nameAbdruck=${nameAbdruck(
        'Musterverein Ostend e. V.',
      )}`,
      TOKEN_PLAIN,
      expect.any(Number),
    );
    expect((fetch.mock.calls[0] as string[])[0]).not.toContain('Musterverein%20');
    expect(result).toMatchObject({ fetched: 1, successful: 1, failed: 0 });
    expect(upserts).toHaveLength(1);
    const data = (upserts[0] as { create: Record<string, unknown> }).create;
    expect(data.activePersons).toBe(34);
    expect(data.fetchSuccessful).toBe(true);
    expect(data.databaseState).toBe('erreichbar');
  });

  it('schreibt genau ONE Zeile je Instanz und Tag (idempotent)', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: true, values: GOOD_RESPONSE });
    const { service, upserts } = build(ONE, fetch as never);

    await service.executeFrom({ actor: 'test', userId: null });
    const key = (upserts[0] as { where: { instanceId_date: unknown } }).where;
    expect(key.instanceId_date).toEqual({
      instanceId: 'i1',
      date: expect.any(Date),
    });
  });
});

describe('Fehlschläge werden gespeichert, nicht verschluckt (E3-7)', () => {
  it('legt auch für eine Zeitüberschreitung eine Zeile an — ohne Zahlen', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, kind: 'timeout' });
    const { service, upserts } = build(ONE, fetch as never);

    const result = await service.executeFrom({ actor: 'test', userId: null });

    expect(result.failed).toBe(1);
    const data = (upserts[0] as { create: Record<string, unknown> }).create;
    expect(data.fetchSuccessful).toBe(false);
    expect(data.errorKind).toBe('timeout');
    // NULL, NICHT 0. Eine 0 läse das CRM als „niemand mehr da" und löste die
    // Aufgabe „seit 45 Tagen kein Eintrag" aus, obwohl niemand etwas weiss.
    expect(data.activePersons).toBeNull();
    expect(data.circles).toBeNull();
  });

  it('speichert nur FESTE Fehlerarten, nie eine rohe Meldung', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: false, kind: 'rejected' });
    const { service, upserts } = build(ONE, fetch as never);
    await service.executeFrom({ actor: 'test', userId: null });

    const data = (upserts[0] as { create: Record<string, unknown> }).create;
    expect([
      'no_token',
      'timeout',
      'unreachable',
      'rejected',
      'inactive',
      'unexpected_response',
    ]).toContain(data.errorKind);
    expect(JSON.stringify(data)).not.toContain(TOKEN_PLAIN);
  });

  it('meldet eine Instanz ohne Token als `kein_token`, ohne sie abzufragen', async () => {
    const fetch = jest.fn();
    const { service, upserts } = build(
      [{ id: 'i1', subdomain: 'ohne-token', metricsTokenEncrypted: null, company: { name: 'Musterverein Ostend e. V.' } }],
      fetch as never,
    );

    await service.executeFrom({ actor: 'test', userId: null });

    expect(fetch).not.toHaveBeenCalled();
    expect((upserts[0] as { create: { errorKind: string } }).create.errorKind).toBe(
      'no_token',
    );
  });

  it('meldet einen nicht entschlüsselbaren Token, statt ihn zu übergehen', async () => {
    const fetch = jest.fn();
    const { service, upserts } = build(
      [{ id: 'i1', subdomain: 'kaputt', metricsTokenEncrypted: 'unlesbar', company: { name: 'Musterverein Ostend e. V.' } }],
      fetch as never,
    );

    await service.executeFrom({ actor: 'test', userId: null });

    expect(fetch).not.toHaveBeenCalled();
    expect((upserts[0] as { create: { errorKind: string } }).create.errorKind).toBe(
      'no_token',
    );
  });
});

describe('Eine hängende Instanz blockiert den Lauf nicht', () => {
  it('fragt die übrigen weiter ab, wenn eine scheitert', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, kind: 'unreachable' })
      .mockResolvedValueOnce({ ok: true, values: GOOD_RESPONSE })
      .mockResolvedValueOnce({ ok: true, values: GOOD_RESPONSE });
    const { service, upserts } = build(
      [
        { id: 'i1', subdomain: 'haengt', metricsTokenEncrypted: TOKEN_ENCRYPTED, company: { name: 'Musterverein Ostend e. V.' } },
        { id: 'i2', subdomain: 'laeuft', metricsTokenEncrypted: TOKEN_ENCRYPTED, company: { name: 'Musterverein Ostend e. V.' } },
        { id: 'i3', subdomain: 'auch', metricsTokenEncrypted: TOKEN_ENCRYPTED, company: { name: 'Musterverein Ostend e. V.' } },
      ],
      fetch as never,
    );

    const result = await service.executeFrom({ actor: 'test', userId: null });

    expect(result).toMatchObject({ fetched: 3, successful: 2, failed: 1 });
    expect(upserts).toHaveLength(3);
  });

  it('gibt jeder Abfrage eine endliche Zeitgrenze mit', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: true, values: GOOD_RESPONSE });
    const { service } = build(ONE, fetch as never);
    await service.executeFrom({ actor: 'test', userId: null });

    const limit = (fetch.mock.calls[0] as unknown[])[2] as number;
    expect(limit).toBeGreaterThan(0);
    expect(Number.isFinite(limit)).toBe(true);
  });
});

describe('Audit', () => {
  it('protokolliert die Zusammenfassung ohne den Token', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: true, values: GOOD_RESPONSE });
    const { service, auditRows } = build(ONE, fetch as never);
    await service.executeFrom({ actor: 'test', userId: null });

    expect(auditRows).toHaveLength(1);
    expect(JSON.stringify(auditRows)).not.toContain(TOKEN_PLAIN);
    expect(JSON.stringify(auditRows)).toContain('metrics.fetch');
  });

  it('lässt den Lauf nicht scheitern, wenn nur die Zusammenfassung scheitert', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: true, values: GOOD_RESPONSE });
    const { service } = build(ONE, fetch as never);
    // Die einzelnen Zeilen stehen bereits; die Arbeit ist getan ([H3]).
    (service as unknown as { audit: { log: jest.Mock } }).audit = {
      log: jest.fn().mockRejectedValue(new Error('Audit kaputt')),
    };

    await expect(
      service.executeFrom({ actor: 'test', userId: null }),
    ).resolves.toMatchObject({ successful: 1 });
  });
});

describe('isMetricsResponse — die Antwort einer fremden Instanz', () => {
  it('nimmt die vereinbarte Form an', () => {
    expect(isMetricsResponse(GOOD_RESPONSE)).toBe(true);
    expect(
      isMetricsResponse({ ...GOOD_RESPONSE, aktivePersonen: null, kreise: null }),
    ).toBe(true);
  });

  it('weist alles andere ab, statt es halb zu übernehmen', () => {
    expect(isMetricsResponse(null)).toBe(false);
    expect(isMetricsResponse('34')).toBe(false);
    expect(isMetricsResponse({ ...GOOD_RESPONSE, datenbank: 'unknown' })).toBe(false);
    expect(
      isMetricsResponse({ ...GOOD_RESPONSE, letzterEintragAm: 'gestern' }),
    ).toBe(false);
    expect(isMetricsResponse({ ...GOOD_RESPONSE, appVersion: 5 })).toBe(false);
  });
});

describe('getViaHttp — Fehlerarten', () => {
  const oldFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = oldFetch;
  });

  it('liest 404 als „auf dieser Instanz nicht aktiv"', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue({ status: 404, ok: false }) as never;
    await expect(getViaHttp('https://x/api', 't', 100)).resolves.toEqual({
      ok: false,
      kind: 'inactive',
    });
  });

  it('liest 401 als „abgewiesen"', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue({ status: 401, ok: false }) as never;
    await expect(getViaHttp('https://x/api', 't', 100)).resolves.toEqual({
      ok: false,
      kind: 'rejected',
    });
  });

  it('bricht nach der Zeitgrenze ab, statt zu hängen', async () => {
    globalThis.fetch = jest.fn().mockImplementation(
      (_url: string, options: { signal: AbortSignal }) =>
        new Promise((_fulfilled, rejected) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('abgebrochen');
            error.name = 'AbortError';
            rejected(error);
          });
        }),
    ) as never;

    await expect(getViaHttp('https://x/api', 't', 30)).resolves.toEqual({
      ok: false,
      kind: 'timeout',
    });
  });

  it('liest eine formwidrige Antwort als „unerwartete_antwort"', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ name: 'Musterverein Ostend e. V.' }),
    }) as never;

    await expect(getViaHttp('https://x/api', 't', 100)).resolves.toEqual({
      ok: false,
      kind: 'unexpected_response',
    });
  });
});

describe('Tagesdatum', () => {
  it('benutzt den heutigen Tag als Schlüssel der Zeitreihe', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: true, values: GOOD_RESPONSE });
    const { service } = build(ONE, fetch as never);
    const result = await service.executeFrom({ actor: 'test', userId: null });
    expect(result.day).toBe(today());
  });
});

// ---------------------------------------------------------------------------
// [K5] Ein Fehlschlag darf den Tageslauf nicht beenden.
// ---------------------------------------------------------------------------

describe('Ein Schreibfehler beendet den Lauf nicht ([K5])', () => {
  /** Prisma, dessen `upsert` bei der ERSTEN Instanz wirft. */
  function buildWithWriteError(instances: Row[], fetch: MetricsFetch) {
    const written: string[] = [];
    let firstAttempt = true;
    const prisma = {
      instance: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue(instances),
        update: jest.fn().mockResolvedValue({}),
      },
      metric: {
        upsert: jest.fn().mockImplementation((arg: { where: { instanceId_date: { instanceId: string } } }) => {
          const id = arg.where.instanceId_date.instanceId;
          if (id === 'i1' && firstAttempt) {
            firstAttempt = false;
            // So sieht es aus, wenn eine Zahl die Int-Spalte sprengt.
            return Promise.reject(new Error('value out of range for type integer'));
          }
          written.push(id);
          return Promise.resolve({});
        }),
      },
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const crypto = { decrypt: () => TOKEN_PLAIN };
    const config = { get: (_k: string, d?: string) => d };
    const coolifyConfig = {
    contract: () => ({ ...CONTRACT_PRESET, baseDomain: 'example.com' }),
  };
    const service = new MetricsFetchService(
      prisma as never,
      audit as never,
      crypto as never,
      config as never,
      coolifyConfig as never,
      fetch,
    );
    return { service, written };
  }

  const TWO: Row[] = [
    { id: 'i1', subdomain: 'kaputt', metricsTokenEncrypted: TOKEN_ENCRYPTED, company: { name: 'Musterverein Ostend e. V.' } },
    { id: 'i2', subdomain: 'gesund', metricsTokenEncrypted: TOKEN_ENCRYPTED, company: { name: 'Musterverein Ostend e. V.' } },
  ];

  it('fragt die zweite Instanz auch dann ab, wenn die erste beim Schreiben scheitert', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: true, values: GOOD_RESPONSE });
    const { service, written } = buildWithWriteError(TWO, fetch as never);

    const result = await service.executeFrom({ actor: 'test', userId: null });

    // Ohne das `try` je Instanz brach der Lauf hier ab: `abgefragt: 2`, aber
    // NULL geschriebene Zeilen.
    expect(result.fetched).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    // Beide Instanzen haben eine Zeile — die erste als Fehlschlag.
    expect(written.sort()).toEqual(['i1', 'i2']);
  });

  it('hält den Fehlschlag der ersten Instanz als Zeile fest, statt sie zu übergehen (E3-7)', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: true, values: GOOD_RESPONSE });
    const { service } = buildWithWriteError(TWO, fetch as never);

    const result = await service.executeFrom({ actor: 'test', userId: null });

    expect(result.failed).toBe(1);
    expect(result.successful).toBe(1);
  });

  it('läuft weiter, wenn die Abfrage selbst wirft statt abzulehnen', async () => {
    const fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error('irgendetwas Unerwartetes'))
      .mockResolvedValue({ ok: true, values: GOOD_RESPONSE });
    const { service, upserts } = build(TWO, fetch as never);

    const result = await service.executeFrom({ actor: 'test', userId: null });

    expect(result).toMatchObject({ fetched: 2, successful: 1, failed: 1 });
    expect(upserts).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// [K5]/[W1] Schranken für Zahlen und Version.
// ---------------------------------------------------------------------------

describe('isCountValue — was in die Int-Spalte passt', () => {
  it('nimmt gewöhnliche Zählwerte und null an', () => {
    expect(isCountValue(0)).toBe(true);
    expect(isCountValue(34)).toBe(true);
    expect(isCountValue(INT4_MAX)).toBe(true);
    expect(isCountValue(null)).toBe(true);
  });

  it('weist ab, was die Spalte sprengt oder keine Anzahl ist', () => {
    // `1e12` ist endlich — `Number.isFinite` allein hätte es durchgelassen.
    expect(isCountValue(1e12)).toBe(false);
    expect(isCountValue(INT4_MAX + 1)).toBe(false);
    expect(isCountValue(-1)).toBe(false);
    expect(isCountValue(3.5)).toBe(false);
    expect(isCountValue(Number.NaN)).toBe(false);
    expect(isCountValue('34')).toBe(false);
  });
});

describe('Version der Gegenseite — der EMPFÄNGER prüft ([W1])', () => {
  it('nimmt gewöhnliche Versionsnummern an', () => {
    expect(APP_VERSION_PATTERN.test('0.5.2')).toBe(true);
    expect(APP_VERSION_PATTERN.test('12.0.311')).toBe(true);
    expect(APP_VERSION_PATTERN.test('1.0.0-rc.2')).toBe(true);
  });

  it('weist eine Million Zeichen ab, statt sie zu speichern', () => {
    expect(APP_VERSION_PATTERN.test('9'.repeat(1_000_000))).toBe(false);
    expect(APP_VERSION_PATTERN.test(`0.5.2-${'x'.repeat(1000)}`)).toBe(false);
  });

  it('weist alles ab, was keine Versionsnummer ist', () => {
    expect(APP_VERSION_PATTERN.test('<!DOCTYPE html>')).toBe(false);
    expect(APP_VERSION_PATTERN.test('')).toBe(false);
  });

  it('verwirft eine ganze Antwort, deren Version unbrauchbar ist', () => {
    expect(
      isMetricsResponse({ ...GOOD_RESPONSE, appVersion: 'x'.repeat(100_000) }),
    ).toBe(false);
  });

  it('verwirft eine Antwort, deren Zahl die Spalte sprengt', () => {
    expect(isMetricsResponse({ ...GOOD_RESPONSE, aktivePersonen: 1e12 })).toBe(false);
  });
});

describe('Der Name verlässt das CRM nicht ([W3])', () => {
  it('hängt einen Abdruck an die Adresse, niemals den Namen', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: true, values: GOOD_RESPONSE });
    const { service } = build(
      [
        {
          id: 'i1',
          subdomain: 'musterverein',
          metricsTokenEncrypted: TOKEN_ENCRYPTED,
          company: { name: 'Wohnprojekt Grünzug e. V.' },
        },
      ],
      fetch as never,
    );

    await service.executeFrom({ actor: 'test', userId: null });

    const url = (fetch.mock.calls[0] as string[])[0];
    expect(url).toContain('nameAbdruck=');
    expect(url.toLowerCase()).not.toContain('wohnprojekt');
    expect(url.toLowerCase()).not.toContain('gr%c3%bcnzug');
    expect(/nameAbdruck=[0-9a-f]{64}$/.test(url)).toBe(true);
  });

  it('speichert das Ergebnis des Abgleichs', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      values: { ...GOOD_RESPONSE, organisationsnameStimmt: false },
    });
    const { service, upserts } = build(ONE, fetch as never);

    await service.executeFrom({ actor: 'test', userId: null });

    expect(
      (upserts[0] as { create: { companyNameMatches: unknown } }).create
        .companyNameMatches,
    ).toBe(false);
  });

  it('speichert „nicht gemessen" als null, nicht als false', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      values: { ...GOOD_RESPONSE, organisationsnameStimmt: null },
    });
    const { service, upserts } = build(ONE, fetch as never);

    await service.executeFrom({ actor: 'test', userId: null });

    expect(
      (upserts[0] as { create: { companyNameMatches: unknown } }).create
        .companyNameMatches,
    ).toBeNull();
  });

  it('nimmt eine Instanz auf ÄLTEREM Stand weiterhin an (Feld fehlt ganz)', async () => {
    // RÜCKWÄRTSKOMPATIBILITÄT: Sonst lieferte nach dem Ausrollen des CRM keine
    // einzige bestehende Instanz mehr Kennzahlen, bis sie neu deployt ist.
    const withoutField: Record<string, unknown> = { ...GOOD_RESPONSE };
    delete withoutField.organisationsnameStimmt;
    expect(isMetricsResponse(withoutField)).toBe(true);

    const fetch = jest.fn().mockResolvedValue({ ok: true, values: withoutField });
    const { service, upserts } = build(ONE, fetch as never);
    const result = await service.executeFrom({ actor: 'test', userId: null });

    expect(result.successful).toBe(1);
    expect(
      (upserts[0] as { create: { companyNameMatches: unknown } }).create
        .companyNameMatches,
    ).toBeNull();
  });

  it('weist einen unbrauchbaren Wert in diesem Feld ab', () => {
    expect(
      isMetricsResponse({ ...GOOD_RESPONSE, organisationsnameStimmt: 'Musterverein' }),
    ).toBe(false);
  });
});


/**
 * Der Abruf vermerkt auch den ABSCHLUSS DER EINRICHTUNG — die zweite Quelle
 * neben der Setup-Auskunft beim Öffnen der Karte.
 */
describe('Abschluss der Einrichtung', () => {
  it('vermerkt ihn, sobald aktive Personen gemeldet werden — nur von null aus', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: true, values: GOOD_RESPONSE });
    const { service, prisma } = build(ONE, fetch as never);

    await service.executeFrom({ actor: 'test', userId: null });

    expect(prisma.instance.updateMany).toHaveBeenCalledWith({
      where: { id: 'i1', setupCompletedAt: null },
      data: { setupCompletedAt: expect.any(Date) },
    });
  });

  it('vermerkt nichts bei einem Fehlschlag', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: false, kind: 'unreachable' });
    const { service, prisma } = build(ONE, fetch as never);

    await service.executeFrom({ actor: 'test', userId: null });

    expect(prisma.instance.updateMany).not.toHaveBeenCalled();
  });

  it('vermerkt nichts, solange die Instanz leer ist (keine Person, keine Organisation)', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      values: { ...GOOD_RESPONSE, aktivePersonen: 0, organisationsnameStimmt: null },
    });
    const { service, prisma } = build(ONE, fetch as never);

    await service.executeFrom({ actor: 'test', userId: null });

    expect(prisma.instance.updateMany).not.toHaveBeenCalled();
  });
});

describe('Einzelabruf — der Knopf „Kennzahlen jetzt abrufen"', () => {
  it('gibt null, wenn es keine aktive Instanz gibt', async () => {
    const fetch = jest.fn();
    const { service } = build([], fetch as never);

    expect(
      await service.executeFromFor('o1', { actor: 'sam', userId: null }),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fragt genau diese eine Instanz ab und schreibt dieselbe Tageszeile', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: true, values: GOOD_RESPONSE });
    const { service, prisma, upserts } = build([], fetch as never);
    prisma.instance.findFirst = jest.fn().mockResolvedValue(ONE[0]);

    const result = await service.executeFromFor('o1', { actor: 'sam', userId: null });

    expect(result).toEqual({ successful: true, errorKind: null });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(upserts).toHaveLength(1);
  });
});
