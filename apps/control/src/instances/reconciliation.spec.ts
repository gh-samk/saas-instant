import { ReconciliationService } from './reconciliation.service';
import { CONTRACT_PRESET } from '../coolify/coolify.config';
import { CoolifyProvisioner } from '../coolify/coolify.provisioner';
import { CoolifyMock } from '../test-support/coolify-mock';

interface InstanceRow {
  id: string;
  companyId: string;
  subdomain: string;
  status: string;
  coolifyApplicationId: string | null;
}

function build(
  instances: InstanceRow[],
  coolify = new CoolifyMock(),
  ownApplications: readonly string[] = [],
) {
  const stored: Record<string, unknown>[] = [];
  const prisma = {
    instance: {
      // Wie die Datenbank: je nach Statusfilter nur die passenden Zeilen.
      findMany: jest.fn().mockImplementation(({ where }: { where: { status: string | { in: string[] } } }) =>
        Promise.resolve(
          instances.filter((i) =>
            typeof where.status === 'string' ? i.status === where.status : where.status.in.includes(i.status),
          ),
        ),
      ),
    },
    reconciliationRun: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((arg: { data: Record<string, unknown> }) => {
        stored.push(arg.data);
        return Promise.resolve({});
      }),
    },
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const config = { get: (_k: string, d?: string) => d };
  const coolifyConfig = {
    contract: () => ({ ...CONTRACT_PRESET, baseDomain: 'example.com' }),
    read: () => ({ ownApplications }),
  };
  const service = new ReconciliationService(
    prisma as never,
    audit as never,
    config as never,
    coolifyConfig as never,
    new CoolifyProvisioner(coolify, async () => undefined),
  );
  return { service, coolify, stored, prisma };
}

const TRIGGER = { actor: 'test', userId: null };

describe('Abgleich — er meldet, er korrigiert nicht (E3-16)', () => {
  it('meldet die gestoppte Anwendung einer archivierten Instanz nicht als verwaist', async () => {
    const coolify = new CoolifyMock();
    coolify.setUp('instance-altverein', 'altverein.example.com', 'exited');
    const { service } = build(
      [{ id: 'i1', companyId: 'o1', subdomain: 'altverein', status: 'archived', coolifyApplicationId: null }],
      coolify,
    );

    const result = await service.executeFrom(TRIGGER);

    expect(result.orphanedApplications).toEqual([]);
    expect(result.deviations).toEqual([]);
  });

  it('meldet nach der Löschung nichts: weder Anwendung noch Abweichung', async () => {
    const { service } = build([
      { id: 'i1', companyId: 'o1', subdomain: 'geloescht', status: 'archived', coolifyApplicationId: null },
    ]);

    const result = await service.executeFrom(TRIGGER);

    expect(result).toMatchObject({ successful: true, orphanedApplications: [], deviations: [] });
  });

  it('meldet eine CRM-Instanz ohne Coolify-Anwendung', async () => {
    const { service } = build([
      {
        id: 'i1',
        companyId: 'o1',
        subdomain: 'verschwunden',
        status: 'active',
        coolifyApplicationId: 'weg',
      },
    ]);

    const result = await service.executeFrom(TRIGGER);

    expect(result.deviations).toEqual([
      {
        instanceId: 'i1',
        companyId: 'o1',
        kind: 'without_coolify_application',
        crmStatus: 'active',
        coolifyStatus: null,
      },
    ]);
  });

  it('meldet einen Statusunterschied', async () => {
    const coolify = new CoolifyMock();
    const application = coolify.setUp(
      'instance-gestoppt-dort',
      'gestoppt-dort.example.com',
      'exited',
    );
    const { service } = build(
      [
        {
          id: 'i1',
          companyId: 'o1',
          subdomain: 'gestoppt-dort',
          status: 'active',
          coolifyApplicationId: application.uuid,
        },
      ],
      coolify,
    );

    const result = await service.executeFrom(TRIGGER);

    expect(result.deviations).toHaveLength(1);
    expect(result.deviations[0]).toMatchObject({
      kind: 'statusunterschied',
      crmStatus: 'active',
      coolifyStatus: 'exited',
    });
  });

  it('meldet nichts, wenn beide Seiten übereinstimmen', async () => {
    const coolify = new CoolifyMock();
    const application = coolify.setUp('instance-passt', 'passt.example.com', 'running');
    const { service } = build(
      [
        {
          id: 'i1',
          companyId: 'o1',
          subdomain: 'passt',
          status: 'active',
          coolifyApplicationId: application.uuid,
        },
      ],
      coolify,
    );

    const result = await service.executeFrom(TRIGGER);

    expect(result.deviations).toEqual([]);
    expect(result.orphanedApplications).toEqual([]);
  });

  it('meldet eine Coolify-Anwendung ohne CRM-Eintrag als verwaist', async () => {
    const coolify = new CoolifyMock();
    coolify.setUp('instance-fremd', 'fremd.example.com');
    const { service } = build([], coolify);

    const result = await service.executeFrom(TRIGGER);

    expect(result.orphanedApplications).toHaveLength(1);
    expect(result.orphanedApplications[0]).toMatchObject({
      subdomain: 'fremd',
      coolifyUrl: 'https://fremd.example.com',
    });
  });

  it('übergeht fremde Anwendungen im selben Coolify-Projekt', async () => {
    const coolify = new CoolifyMock();
    coolify.setUp('ganz-andere-anwendung', 'andere.example.com');
    const { service } = build([], coolify);

    expect((await service.executeFrom(TRIGGER)).orphanedApplications).toEqual([]);
  });

  it('übergeht eine Instanz, die gerade erst angelegt wird', async () => {
    // In den ersten Minuten ist sie in Coolify noch nicht sichtbar. Das ist
    // der Normalfall und kein Befund.
    const { service } = build([
      {
        id: 'i1',
        companyId: 'o1',
        subdomain: 'frisch',
        status: 'provisioning',
        coolifyApplicationId: null,
      },
    ]);

    expect((await service.executeFrom(TRIGGER)).deviations).toEqual([]);
  });

  it('ändert weder in Coolify noch am CRM-Register etwas', async () => {
    const coolify = new CoolifyMock();
    coolify.setUp('instance-fremd', 'fremd.example.com');
    const { service, prisma } = build(
      [
        {
          id: 'i1',
          companyId: 'o1',
          subdomain: 'weg',
          status: 'active',
          coolifyApplicationId: null,
        },
      ],
      coolify,
    );

    await service.executeFrom(TRIGGER);

    // Gelesen wurde; geschrieben wurde ausschliesslich in die EIGENE
    // Lauf-Historie.
    expect(coolify.calls).toEqual(['applications']);
    expect(coolify.stopped).toEqual([]);
    expect(prisma.instance.findMany).toHaveBeenCalled();
    expect(prisma.reconciliationRun.create).toHaveBeenCalledTimes(1);
  });
});

describe('Ein gescheiterter Lauf ist kein leerer Befund', () => {
  it('speichert `erfolgreich: false` samt Grund, statt „keine Abweichungen" zu melden', async () => {
    const coolify = new CoolifyMock();
    coolify.failsAt = 'applications';
    const { service, stored } = build([], coolify);

    const result = await service.executeFrom(TRIGGER);

    expect(result.successful).toBe(false);
    expect(result.message).toContain('nicht erreichbar');
    expect(stored[0].successful).toBe(false);
  });
});

describe('Verwaiste behalten den Tag des ERSTEN Befunds', () => {
  it('übernimmt `detectedAt` aus dem vorherigen Lauf', async () => {
    const coolify = new CoolifyMock();
    coolify.setUp('instance-alt', 'alt.example.com');
    const { service, prisma } = build([], coolify);
    prisma.reconciliationRun.findFirst = jest.fn().mockResolvedValue({
      successful: true,
      message: null,
      deviations: [],
      orphanedApplications: [
        { subdomain: 'alt', coolifyUrl: null, detectedAt: '2026-07-01' },
      ],
      executedAt: new Date('2026-07-01T04:30:00.000Z'),
    });

    const result = await service.executeFrom(TRIGGER);

    expect(result.orphanedApplications[0].detectedAt).toBe('2026-07-01');
  });
});

/**
 * ===========================================================================
 * DIE EIGENEN DEPLOYMENTS SIND KEINE WAISEN
 * ===========================================================================
 *
 * `GET /applications` liefert ALLES, was in Coolify liegt — auch die
 * Verwaltung selbst, die Webseite und die Kunden-App. Sie heissen nach
 * demselben Schema wie eine Kundeninstanz (`instance-<subdomain>`) und
 * standen deshalb dauerhaft unter „Heute" als „Keine passende Organisation im
 * CRM gefunden".
 *
 * WARUM DAS EIN PROBLEM WAR und nicht nur unschön: Vier Befunde, die immer
 * dastehen, machen aus der Liste eine, die niemand mehr liest. Dann rutscht
 * der eine echte Fund durch, für den es sie gibt — eine Kundeninstanz, die in
 * Coolify läuft und die niemand ins CRM eingetragen hat. Derselbe Mechanismus
 * wie bei einem Testlauf, der jeden zehnten Durchgang rot wird.
 */
describe('Eigene Anwendungen bleiben aus der Waisenliste heraus', () => {
  /** Der Bestand des Betreibers, wie er in Coolify liegt. */
  function withOwn(coolify: CoolifyMock): void {
    coolify.setUp('instance-app', 'demo.example.com');
    coolify.setUp('instance-control', 'verwaltung.example.com');
    coolify.setUp('instance-webseite', 'vorschau.example.com');
    coolify.setUp('instance-platzhalter', 'platzhalter.example');
  }

  const OWN = [
    'instance-app',
    'instance-control',
    'instance-webseite',
    'instance-platzhalter',
  ];

  it('MELDET SIE NICHT MEHR, wenn sie in der Liste stehen', async () => {
    const coolify = new CoolifyMock();
    withOwn(coolify);
    const { service } = build([], coolify, OWN);

    const result = await service.executeFrom(TRIGGER);
    expect(result.orphanedApplications).toEqual([]);
  });

  it('MELDET SIE SEHR WOHL, wenn die Liste leer ist', async () => {
    // Die Gegenprobe im Test selbst: Ohne sie belegte der Test oben nur, dass
    // die Attrappe nichts liefert.
    const coolify = new CoolifyMock();
    withOwn(coolify);
    const { service } = build([], coolify, []);

    const result = await service.executeFrom(TRIGGER);
    expect(result.orphanedApplications).toHaveLength(4);
  });

  it('LÄSST ONE ECHTE WAISE DANEBEN STEHEN', async () => {
    // Der Kern der Sache: Die Ausblendung darf den Befund nicht mitnehmen,
    // für den es die Liste gibt.
    const coolify = new CoolifyMock();
    withOwn(coolify);
    coolify.setUp('instance-beispiel', 'beispiel.example.com');
    const { service } = build([], coolify, OWN);

    const result = await service.executeFrom(TRIGGER);
    expect(result.orphanedApplications).toHaveLength(1);
    expect(result.orphanedApplications[0]!.subdomain).toBe('beispiel');
  });

  it('blendet nur EXAKTE Namen aus, keine Präfixe', async () => {
    // `instance-app` darf nicht auch `instance-appenzell` verdecken — sonst
    // wäre die Liste ein Filter mit unabsehbarer Reichweite.
    const coolify = new CoolifyMock();
    coolify.setUp('instance-app', 'demo.example.com');
    coolify.setUp('instance-appenzell', 'appenzell.example.com');
    const { service } = build([], coolify, ['instance-app']);

    const result = await service.executeFrom(TRIGGER);
    expect(result.orphanedApplications.map((a) => a.subdomain)).toEqual([
      'appenzell',
    ]);
  });

  it('rührt die ABWEICHUNGEN nicht an', async () => {
    // Eine CRM-Instanz ohne Coolify-Anwendung ist ein anderer Befund. Die
    // Ausblendung gilt nur für Waisen; sie darf keine Abweichung schlucken.
    const coolify = new CoolifyMock();
    withOwn(coolify);
    const { service } = build(
      [
        {
          id: 'i1',
          companyId: 'o1',
          subdomain: 'beispiel',
          status: 'active',
          coolifyApplicationId: null,
        },
      ],
      coolify,
      OWN,
    );

    const result = await service.executeFrom(TRIGGER);
    expect(result.orphanedApplications).toEqual([]);
    expect(result.deviations).toHaveLength(1);
    expect(result.deviations[0]!.kind).toBe('without_coolify_application');
  });
});
