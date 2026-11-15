import { PRICE_PRESETS } from '../../invoices/pricing.config';
import type { TasksContext } from '../tasks.types';
import { reconciliationDeviation } from './reconciliation-deviation.source';
import { backupMissing } from './backup-missing.source';
import { noEntryForLong } from './no-entry-for-long.source';
import { metricsQueryFailed } from './metrics-failed.source';
import { companyNameMismatch } from './company-name-mismatch.source';
import { NO_ENTRY_DAYS } from '../../instances/instance.rules';

const Today = '2026-08-31';
const Company = { id: 'o1', name: 'Musterverein Ostend e. V.', status: 'paying' };

function contextWith(prisma: unknown): TasksContext {
  return {
    prisma: prisma as never,
    todayDay: Today,
    now: new Date(`${Today}T09:00:00.000Z`),
    since: '2026-08-24',
    limit: 25,
    // Keine dieser fuenf Quellen liest die Preistafel; sie steht hier, weil
    // der Kontext sie verlangt.
    priceTable: PRICE_PRESETS,
    outbox: [],
  };
}

function day(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

// ---------------------------------------------------------------------------

describe('backup_ausgeblieben — die Stille ist das Signal', () => {
  const instance = (backups: { date: Date }[]) => ({
    id: 'i1',
    subdomain: 'musterverein',
    createdAt: day('2026-01-01'),
    company: Company,
    backups,
  });

  it('meldet eine Instanz, deren letzte Sicherung zu lange her ist', async () => {
    const prisma = {
      instance: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([instance([{ date: day('2026-08-09') }])]),
      },
    };

    const { tasks } = await backupMissing.collect(contextWith(prisma));

    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Sicherung überfällig');
    expect(tasks[0].reason).toContain('22 Tagen');
    // Überfällig, also `high` — ohne dass die Art dafür eine Sonderregel hätte.
    expect(tasks[0].urgency).toBe('high');
    expect(tasks[0].action.kind).toBe('company_open');
  });

  it('meldet eine Instanz, die noch NIE gesichert wurde', async () => {
    const prisma = {
      instance: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([instance([])]),
      },
    };

    const { tasks } = await backupMissing.collect(contextWith(prisma));

    expect(tasks[0].reason).toContain('noch nie eine Sicherung');
  });

  it('erzeugt im gesunden Fall GAR NICHTS — kein grüner Haken (E3-18)', async () => {
    const prisma = {
      instance: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    expect(await backupMissing.collect(contextWith(prisma))).toEqual({
      tasks: [],
      total: 0,
    });
  });

  it('fragt nur nach AKTIVEN Instanzen — eine archivierte wird nicht gesichert', async () => {
    const prisma = {
      instance: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    await backupMissing.collect(contextWith(prisma));
    const where = (prisma.instance.count.mock.calls[0] as [{ where: { status: string } }])[0]
      .where;
    expect(where.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------

describe('metrics_query_failed', () => {
  it('nennt die Zahl der Tage seit der letzten erfolgreichen Abfrage', async () => {
    const prisma = {
      instance: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'i1',
            subdomain: 'musterverein',
            company: Company,
            metrics: [{ date: day('2026-08-28') }],
          },
        ]),
      },
    };

    const { tasks } = await metricsQueryFailed.collect(contextWith(prisma));

    expect(tasks[0].title).toBe('Kennzahlen-Abfrage schlägt fehl');
    expect(tasks[0].reason).toContain('3 Tagen');
    expect(tasks[0].reason).toContain('2026-08-28');
  });

  it('nennt den wahrscheinlichen Grund, wenn nie eine Antwort kam', async () => {
    const prisma = {
      instance: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'i1',
            subdomain: 'neu',
            company: Company,
            metrics: [],
          },
        ]),
      },
    };

    const { tasks } = await metricsQueryFailed.collect(contextWith(prisma));
    expect(tasks[0].reason).toContain('METRICS_TOKEN');
  });
});

// ---------------------------------------------------------------------------

describe('kein_eintrag_lange — die geschäftlich wichtigste Zeile', () => {
  const instanceWith = (lastEntry: Date | null) => ({
    id: 'i1',
    subdomain: 'musterverein',
    company: Company,
    metrics: lastEntry === null ? [] : [{ lastEntryAt: lastEntry }],
  });

  it('meldet eine Instanz, in der seit 45 Tagen nichts protokolliert wurde', async () => {
    const prisma = {
      instance: { findMany: jest.fn().mockResolvedValue([instanceWith(day('2026-07-01'))]) },
    };

    const { tasks } = await noEntryForLong.collect(contextWith(prisma));

    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Seit 61 Tagen kein Eintrag');
    expect(tasks[0].reason).toContain('Nichtnutzung');
  });

  it('ist von der ersten Sekunde an ÜBERFÄLLIG — das ist ihr ganzes Gewicht', async () => {
    // Genau 45 Tage her: `dueAt` ist damit heute, also `high`. Es gibt
    // keinen Zustand, in dem diese Aufgabe „niedrig" wäre.
    const gradeEben = new Date(Date.UTC(2026, 6, 17)); // 2026-07-17 = HEUTE - 45
    const prisma = {
      instance: { findMany: jest.fn().mockResolvedValue([instanceWith(gradeEben)]) },
    };

    const { tasks } = await noEntryForLong.collect(contextWith(prisma));

    expect(NO_ENTRY_DAYS).toBe(45);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].urgency).toBe('high');
    expect(tasks[0].dueAt <= Today).toBe(true);
  });

  it('meldet nichts, solange die Instanz benutzt wird', async () => {
    const prisma = {
      instance: { findMany: jest.fn().mockResolvedValue([instanceWith(day('2026-08-25'))]) },
    };
    expect((await noEntryForLong.collect(contextWith(prisma))).tasks).toEqual([]);
  });

  it('meldet NICHTS, wenn gar keine Messung vorliegt', async () => {
    // Fehlende Messung ist keine Nichtnutzung. Dafür ist die Quelle
    // `kennzahlen_abfrage_fehlgeschlagen` zuständig — sonst stünde für
    // dieselbe Ursache zweimal eine Aufgabe da, und eine davon wäre falsch.
    const prisma = {
      instance: { findMany: jest.fn().mockResolvedValue([instanceWith(null)]) },
    };
    expect((await noEntryForLong.collect(contextWith(prisma))).tasks).toEqual([]);
  });

  it('kappt bei der Grenze und nennt trotzdem die Gesamtzahl', async () => {
    const many = Array.from({ length: 30 }, (_unused, nr) => ({
      id: `i${nr}`,
      subdomain: `verein-${nr}`,
      company: { ...Company, id: `o${nr}` },
      metrics: [{ lastEntryAt: day('2026-06-01') }],
    }));
    const prisma = { instance: { findMany: jest.fn().mockResolvedValue(many) } };

    const result = await noEntryForLong.collect(contextWith(prisma));

    expect(result.tasks).toHaveLength(25);
    expect(result.total).toBe(30);
  });
});

// ---------------------------------------------------------------------------

describe('reconciliation_deviation', () => {
  const run = (deviations: unknown[], successful = true) => ({
    executedAt: new Date('2026-08-31T04:30:00.000Z'),
    successful,
    message: null,
    deviations,
    orphanedApplications: [],
  });

  it('macht aus einer Abweichung eine ganz normale Aufgabe', async () => {
    const prisma = {
      reconciliationRun: {
        findFirst: jest.fn().mockResolvedValue(
          run([
            {
              instanceId: 'i1',
              companyId: 'o1',
              kind: 'statusunterschied',
              crmStatus: 'active',
              coolifyStatus: 'exited',
            },
          ]),
        ),
      },
      company: { findMany: jest.fn().mockResolvedValue([Company]) },
    };

    const { tasks } = await reconciliationDeviation.collect(contextWith(prisma));

    expect(tasks[0].title).toBe('Status weicht von Coolify ab');
    expect(tasks[0].reason).toContain('gleicht nichts an');
    expect(tasks[0].action.target).toBe('/companies/o1');
  });

  it('meldet eine Instanz, die Coolify nicht kennt', async () => {
    const prisma = {
      reconciliationRun: {
        findFirst: jest.fn().mockResolvedValue(
          run([
            {
              instanceId: 'i1',
              companyId: 'o1',
              kind: 'without_coolify_application',
              crmStatus: 'active',
              coolifyStatus: null,
            },
          ]),
        ),
      },
      company: { findMany: jest.fn().mockResolvedValue([Company]) },
    };

    const { tasks } = await reconciliationDeviation.collect(contextWith(prisma));
    expect(tasks[0].title).toBe('Instanz in Coolify nicht auffindbar');
    expect(tasks[0].reason).toContain('nichts gelöscht');
  });

  it('macht aus einem GESCHEITERTEN Lauf keine Aufgaben', async () => {
    const prisma = {
      reconciliationRun: { findFirst: jest.fn().mockResolvedValue(run([], false)) },
      company: { findMany: jest.fn() },
    };
    expect((await reconciliationDeviation.collect(contextWith(prisma))).tasks).toEqual([]);
  });

  it('kommt ohne jeden bisherigen Lauf zurecht', async () => {
    const prisma = {
      reconciliationRun: { findFirst: jest.fn().mockResolvedValue(null) },
      company: { findMany: jest.fn() },
    };
    expect(await reconciliationDeviation.collect(contextWith(prisma))).toEqual({
      tasks: [],
      total: 0,
    });
  });
});

// ---------------------------------------------------------------------------

describe('organisationsname_abweichung — gemessen IN DER INSTANZ ([W3])', () => {
  const instanceWith = (matches: boolean | null, name = 'Musterverein Ostend e. V.') => ({
    subdomain: 'musterverein',
    company: { id: 'o1', name, status: 'paying' },
    metrics:
      matches === null
        ? []
        : [{ date: day('2026-08-30'), companyNameMatches: matches }],
  });

  it('meldet, wenn die Instanz einen anderen Namen führt', async () => {
    const prisma = {
      instance: { findMany: jest.fn().mockResolvedValue([instanceWith(false)]) },
    };

    const { tasks } = await companyNameMismatch.collect(contextWith(prisma));

    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Organisationsname weicht von der Instanz ab');
    expect(tasks[0].reason).toContain('Abdruck');
    // ES WIRD NICHTS ÜBERSCHRIEBEN (E3-20): Die Handlung öffnet nur.
    expect(tasks[0].action.kind).toBe('company_open');
    expect(tasks[0].dueAt).toBe('2026-08-30');
  });

  it('meldet nichts, solange die Namen übereinstimmen', async () => {
    const prisma = {
      instance: { findMany: jest.fn().mockResolvedValue([instanceWith(true)]) },
    };
    expect(
      (await companyNameMismatch.collect(contextWith(prisma))).tasks,
    ).toEqual([]);
  });

  it('macht aus „nicht gemessen" KEINE Abweichung', async () => {
    // Eine Instanz, die noch nie geantwortet hat oder auf älterem Stand läuft,
    // meldet null. Daraus eine Abweichung zu machen wäre eine Behauptung über
    // etwas, das niemand geprüft hat.
    const prisma = {
      instance: {
        findMany: jest.fn().mockResolvedValue([
          instanceWith(null),
          {
            subdomain: 'alt',
            company: { id: 'o2', name: 'Alt e. V.', status: 'paying' },
            metrics: [{ date: day('2026-08-30'), companyNameMatches: null }],
          },
        ]),
      },
    };
    expect(
      (await companyNameMismatch.collect(contextWith(prisma))).tasks,
    ).toEqual([]);
  });

  it('meldet NICHT mehr wegen einer frei gewählten Subdomain — der alte Fehlalarm', async () => {
    // Die frühere Fassung verglich `subdomainVorschlag(CRM-Name)` mit der
    // Subdomain und schlug hier an, obwohl die Namen übereinstimmen.
    const prisma = {
      instance: {
        findMany: jest.fn().mockResolvedValue([
          {
            subdomain: 'kurz',
            company: { id: 'o1', name: 'Wohnprojekt Grünzug', status: 'paying' },
            metrics: [{ date: day('2026-08-30'), companyNameMatches: true }],
          },
        ]),
      },
    };
    expect(
      (await companyNameMismatch.collect(contextWith(prisma))).tasks,
    ).toEqual([]);
  });

  it('fragt nur AKTIVE Instanzen ab', async () => {
    const prisma = { instance: { findMany: jest.fn().mockResolvedValue([]) } };
    await companyNameMismatch.collect(contextWith(prisma));
    const where = (prisma.instance.findMany.mock.calls[0] as [{ where: { status: string } }])[0]
      .where;
    expect(where.status).toBe('active');
  });
});
