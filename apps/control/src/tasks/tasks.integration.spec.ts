import { ConfigService } from '@nestjs/config';
import { datePlusDays, today } from '@saas-instant/shared';
import { AUDIT_ACTION } from '../audit/audit.service';
import { datePlusMonths } from '../common/calendar';
import { PricingConfigService } from '../invoices/pricing.config';
import {
  TasksService,
  LIMIT_PER_KIND,
  LOOKBACK_MAX_DAYS,
} from './tasks.service';
import type { OutboxService } from '../outbox/outbox.service';
import type { Task } from './tasks.types';
import {
  createCompany,
  newPrefix,
  prisma,
  cleanUp,
  day,
  disconnect,
} from '../test-support/company-provisioning';
import { truncateAuditLog } from '../test-support/gobd-cleanup';

/**
 * Die abgeleiteten Aufgaben gegen eine ECHTE Datenbank.
 *
 * Warum nicht mit einer Attrappe: Jede Quelle ist im Kern eine
 * PRISMA-ABFRAGE — verschachtelte `none`-Bedingungen, Datumsvergleiche auf
 * `@db.Date`, ein `take: 1` in einer Unterabfrage. Eine Attrappe prüfte davon
 * nichts, sie prüfte nur die Zeilen dazwischen.
 *
 * Die Prüfungen filtern immer auf die eigenen Organisationen: die Datenbank
 * gehört nicht dieser Suite allein.
 */

jest.setTimeout(60_000);

const Prefix = newPrefix('etappe2-aufg');
// Die Preistafel kommt aus derselben Konfiguration wie im Betrieb: ohne
// gesetzte Umgebungsvariable sind das die Vorgaben des Auftrags.
const priceConfig = new PricingConfigService(new ConfigService());
priceConfig.onModuleInit();
// Der Postausgang ist hier ungeprüft: Diese Suite prüft Datenbankquellen.
const service = new TasksService(prisma, priceConfig, {
  situation: () => [],
} as unknown as OutboxService);

/** Vor so langer Zeit angelegt, dass die 24-Stunden-Frist um ist. */
function beforeHours(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

async function tasksTo(companyId: string, since?: string): Promise<Task[]> {
  const { tasks } = await service.collect(since);
  return tasks.filter((a) => a.company?.id === companyId);
}

afterAll(async () => {
  await cleanUp(Prefix);
  await disconnect();
});

describe('Anfrage ohne Reaktion', () => {
  it('meldet eine Anfrage, die älter als 24 Stunden ist', async () => {
    const company = await createCompany(Prefix, {
      status: 'inquiry',
      createdAt: beforeHours(30),
    });

    const tasks = await tasksTo(company.id);
    const hit = tasks.filter((a) => a.kind === 'inquiry_unanswered');
    expect(hit).toHaveLength(1);
    expect(hit[0].urgency).toBe('high');
    expect(hit[0].action.target).toBe(`/companies/${company.id}`);
  });

  it('meldet eine frische Anfrage NICHT', async () => {
    const company = await createCompany(Prefix, {
      status: 'inquiry',
      createdAt: beforeHours(2),
    });

    expect(await tasksTo(company.id)).toHaveLength(0);
  });

  it('gilt als beantwortet, sobald eine EIGENE Notiz da ist', async () => {
    const company = await createCompany(Prefix, {
      status: 'inquiry',
      createdAt: beforeHours(30),
    });
    await prisma.note.create({
      data: {
        companyId: company.id,
        date: day(today()),
        text: 'Zurückgerufen.',
        bySystem: false,
      },
    });

    expect(await tasksTo(company.id)).toHaveLength(0);
  });

  it('gilt NICHT als beantwortet, wenn nur das System eine Notiz schrieb', async () => {
    // Sonst ließe eine zweite Anfrage derselben Person die Aufgabe
    // verschwinden, obwohl niemand geantwortet hat.
    const company = await createCompany(Prefix, {
      status: 'inquiry',
      createdAt: beforeHours(30),
    });
    await prisma.note.create({
      data: {
        companyId: company.id,
        date: day(today()),
        text: 'Erneute Demo-Anfrage über das Formular, 31.08.2026',
        bySystem: true,
      },
    });

    const tasks = await tasksTo(company.id);
    expect(tasks.filter((a) => a.kind === 'inquiry_unanswered')).toHaveLength(
      1,
    );
  });

  it('gilt als beantwortet, sobald der Status gewechselt wurde', async () => {
    const company = await createCompany(Prefix, {
      status: 'inquiry',
      createdAt: beforeHours(30),
      lastStatusChangeAt: day(today()),
    });

    expect(await tasksTo(company.id)).toHaveLength(0);
  });
});

describe('Überprüfungstermin', () => {
  it('meldet einen Termin innerhalb der nächsten 30 Tage', async () => {
    const company = await createCompany(Prefix, {
      status: 'paying',
      pilotDecisionDate: day('2026-01-01'),
      reviewDueDate: day(datePlusDays(today(), 10)),
    });

    const hit = (await tasksTo(company.id)).filter(
      (a) => a.kind === 'review_date',
    );
    expect(hit).toHaveLength(1);
    expect(hit[0].urgency).toBe('low');
  });

  it('meldet einen überfälligen Termin als „hoch"', async () => {
    const company = await createCompany(Prefix, {
      status: 'review_pending',
      reviewDueDate: day(datePlusDays(today(), -3)),
    });

    const hit = (await tasksTo(company.id)).filter(
      (a) => a.kind === 'review_date',
    );
    expect(hit).toHaveLength(1);
    expect(hit[0].urgency).toBe('high');
  });

  it('meldet einen Termin in ferner Zukunft nicht', async () => {
    const company = await createCompany(Prefix, {
      status: 'paying',
      reviewDueDate: day(datePlusDays(today(), 45)),
    });

    expect(await tasksTo(company.id)).toHaveLength(0);
  });

  it('lässt beendete Organisationen aus', async () => {
    const company = await createCompany(Prefix, {
      status: 'ended',
      reviewDueDate: day(datePlusDays(today(), -3)),
    });

    expect(await tasksTo(company.id)).toHaveLength(0);
  });
});

describe('Automatischer Statuswechsel', () => {
  it('meldet, was der Zeitplan seit dem angegebenen Tag getan hat', async () => {
    const company = await createCompany(Prefix, { status: 'paying' });
    await prisma.auditLog.create({
      data: {
        actor: 'schedule',
        action: AUDIT_ACTION.companyStatusAutomatic,
        objectType: 'Company',
        objectId: company.id,
        beforeValue: { status: 'pilot_running' },
        afterValue: { status: 'paying' },
      },
    });

    const hit = (await tasksTo(company.id)).filter(
      (a) => a.kind === 'status_change_automatic',
    );
    expect(hit).toHaveLength(1);
    expect(hit[0].reason).toContain('Pilot läuft');
    expect(hit[0].reason).toContain('Zahlend');
  });

  it('meldet nichts, was vor dem letzten Blick lag', async () => {
    const company = await createCompany(Prefix, { status: 'paying' });
    await prisma.auditLog.create({
      data: {
        actor: 'schedule',
        action: AUDIT_ACTION.companyStatusAutomatic,
        objectType: 'Company',
        objectId: company.id,
        timestamp: new Date('2026-01-01T03:00:00.000Z'),
        beforeValue: { status: 'pilot_running' },
        afterValue: { status: 'paying' },
      },
    });

    const hit = (
      await tasksTo(company.id, datePlusDays(today(), -7))
    ).filter((a) => a.kind === 'status_change_automatic');
    expect(hit).toHaveLength(0);
  });

  it('meldet einen Wechsel VON HAND nicht als automatisch', async () => {
    const company = await createCompany(Prefix, { status: 'demo' });
    await prisma.auditLog.create({
      data: {
        actor: 'sam',
        action: AUDIT_ACTION.companyStatusChanged,
        objectType: 'Company',
        objectId: company.id,
        beforeValue: { status: 'inquiry' },
        afterValue: { status: 'demo' },
      },
    });

    expect(await tasksTo(company.id)).toHaveLength(0);
  });
});

describe('Löschung vorschlagen (R4)', () => {
  it('schlägt Kontaktdaten nach 24 Monaten ohne Kontakt VOR', async () => {
    const longHer = datePlusMonths(today(), -25);
    const company = await createCompany(Prefix, {
      status: 'inquiry',
      createdAt: day(longHer),
    });

    const hit = (await tasksTo(company.id)).filter(
      (a) => a.kind === 'deletion_suggestion',
    );
    expect(hit).toHaveLength(1);
    expect(hit[0].action.kind).toBe('deletion_check');
    // VORSCHLAG, keine Löschung: die Organisation steht danach unverändert da.
    expect(
      await prisma.company.count({ where: { id: company.id } }),
    ).toBe(1);
  });

  it('schlägt nichts vor, solange es Kontakt gab', async () => {
    const longHer = datePlusMonths(today(), -25);
    const company = await createCompany(Prefix, {
      status: 'inquiry',
      createdAt: day(longHer),
    });
    await prisma.note.create({
      data: {
        companyId: company.id,
        date: day(datePlusMonths(today(), -1)),
        text: 'Noch mal nachgefragt.',
        bySystem: false,
      },
    });

    const hit = (await tasksTo(company.id)).filter(
      (a) => a.kind === 'deletion_suggestion',
    );
    expect(hit).toHaveLength(0);
  });

  it('schlägt nichts vor, wenn es zum Abschluss kam', async () => {
    const longHer = datePlusMonths(today(), -25);
    const company = await createCompany(Prefix, {
      status: 'paying',
      createdAt: day(longHer),
    });

    const hit = (await tasksTo(company.id)).filter(
      (a) => a.kind === 'deletion_suggestion',
    );
    expect(hit).toHaveLength(0);
  });
});

describe('[H1] Preisangabe fehlt', () => {
  it('meldet einen reifen Piloten ohne Preis als Aufgabe', async () => {
    const company = await createCompany(Prefix, {
      status: 'pilot_running',
      instanceStartDate: day(datePlusDays(today(), -100)),
    });

    const hit = (await tasksTo(company.id)).filter(
      (a) => a.kind === 'price_info_missing',
    );
    expect(hit).toHaveLength(1);
    expect(hit[0].action.kind).toBe('price_agree');
  });

  it('meldet nichts, sobald eine Preisstufe hinterlegt ist', async () => {
    const company = await createCompany(Prefix, {
      status: 'pilot_running',
      instanceStartDate: day(datePlusDays(today(), -100)),
      priceTier: 'klein',
    });

    const hit = (await tasksTo(company.id)).filter(
      (a) => a.kind === 'price_info_missing',
    );
    expect(hit).toHaveLength(0);
  });
});

describe('[W5] Aufbewahrungsfrist des Audit-Logs', () => {
  it('meldet Einträge, die älter als drei Jahre sind — und löscht nichts', async () => {
    const company = await createCompany(Prefix);
    const old = await prisma.auditLog.create({
      data: {
        actor: 'test-old',
        action: 'company.created',
        objectType: 'Company',
        objectId: company.id,
        timestamp: new Date('2020-01-01T00:00:00.000Z'),
      },
    });

    const { tasks } = await service.collect();
    const hit = tasks.filter((a) => a.kind === 'audit_retention');
    expect(hit).toHaveLength(1);
    expect(hit[0].company).toBeUndefined();
    expect(hit[0].action.kind).toBe('retention_check');
    // R4: gemeldet, nicht gelöscht.
    expect(
      await prisma.auditLog.count({ where: { id: old.id } }),
    ).toBe(1);

    // AuditLog ist append-only (GoBD-Trigger): Aufräumen nur per TRUNCATE.
    await truncateAuditLog(prisma);
  });
});

describe('[W7] Obergrenze der Liste', () => {
  it('kappt je Art und nennt, wie viele weitere es gäbe', async () => {
    const identifier = `${Prefix}-viele`;
    for (let i = 0; i < LIMIT_PER_KIND + 3; i += 1) {
      await prisma.company.create({
        data: {
          name: `${identifier} ${i}`,
          status: 'inquiry',
          createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
        },
      });
    }

    const { tasks, shortened } = await service.collect();
    const kind = tasks.filter((a) => a.kind === 'inquiry_unanswered');
    expect(kind.length).toBeLessThanOrEqual(LIMIT_PER_KIND);

    const message = shortened.find((g) => g.kind === 'inquiry_unanswered');
    expect(message).toBeDefined();
    expect(message?.shown).toBe(LIMIT_PER_KIND);
    expect(message?.further).toBeGreaterThanOrEqual(3);

    // Gleich wieder weg: Sonst verdrängt dieser Berg in den folgenden Prüfungen
    // genau die Aufgaben, um die es dort geht.
    await prisma.company.deleteMany({
      where: { name: { startsWith: identifier } },
    });
  });

  it('lässt die Rückschau nicht beliebig weit zurückreichen', async () => {
    const { state } = await service.collect('2000-01-01');
    expect(state.since).toBe(datePlusDays(today(), -LOOKBACK_MAX_DAYS));
  });
});

describe('Sortierung und Aufbau', () => {
  it('stellt Dringendes nach vorn', async () => {
    const { tasks } = await service.collect();
    const rang = { high: 0, medium: 1, low: 2 };
    for (let i = 1; i < tasks.length; i += 1) {
      expect(
        rang[tasks[i - 1].urgency] <= rang[tasks[i].urgency],
      ).toBe(true);
    }
  });

  it('gibt jeder Aufgabe Fälligkeit, Dringlichkeit, Bezug und Handlung', async () => {
    const company = await createCompany(Prefix, {
      status: 'inquiry',
      createdAt: beforeHours(30),
    });
    const [task] = await tasksTo(company.id);

    expect(task.dueAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(['high', 'medium', 'low']).toContain(task.urgency);
    expect(task.company?.id).toBe(company.id);
    expect(task.action.label.length).toBeGreaterThan(0);
    expect(task.title.length).toBeGreaterThan(0);
  });
});
