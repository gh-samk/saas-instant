import type { ConfigService } from '@nestjs/config';
import { truncateAuditLog } from '../test-support/gobd-cleanup';
import { datePlusDays, today } from '@saas-instant/shared';
import { AuditService, AUDIT_ACTION } from '../audit/audit.service';
import { TRIAL_DAYS } from '../companies/deadlines';
import { ScheduleService } from './schedule.service';
import {
  auditFrom,
  createCompany,
  newPrefix,
  notesFrom,
  prisma,
  cleanUp,
  statusFrom,
  day,
  disconnect,
} from '../test-support/company-provisioning';

/**
 * Der erste automatische Schreibvorgang — gegen eine ECHTE Datenbank.
 *
 * Drei Zusagen aus dem Auftrag, jede mit eigenem Fall:
 * 1. IDEMPOTENT, auch bei zwei GLEICHZEITIGEN Läufen. Das ist der Fall, den
 *    eine Attrappe nicht führen kann.
 * 2. Ein Fehler bei einer Organisation reißt die übrigen nicht mit.
 * 3. Jeder Wechsel hinterlässt genau eine Notiz und einen Audit-Eintrag.
 */

jest.setTimeout(60_000);

const Prefix = newPrefix('etappe2-zeit');
const Trigger = { actor: 'schedule-test', userId: null };

const audit = new AuditService(prisma);
const config = {
  get: (_key: string, defaultValue?: string) => defaultValue,
} as unknown as ConfigService;
const service = new ScheduleService(prisma, audit, config);

/** Eine Testphase, deren Instanz vor mehr als 14 Tagen startete. */
async function ripeTrial() {
  return createCompany(Prefix, {
    status: 'trial',
    instanceStartDate: day(datePlusDays(today(), -(TRIAL_DAYS + 1))),
    // Ohne Preisvereinbarung wechselt der Zeitplan seit [H1] nicht mehr.
    priceTier: 'klein',
  });
}

afterAll(async () => {
  await truncateAuditLog(prisma);
  await cleanUp(Prefix);
  await disconnect();
});

describe('Regel: Testphase → Zahlend nach 14 Tagen', () => {
  it('wechselt und schreibt Notiz samt Audit-Eintrag', async () => {
    const company = await ripeTrial();

    await service.runFrom(Trigger);

    expect(await statusFrom(company.id)).toBe('paying');
    const notes = await notesFrom(company.id);
    expect(notes).toHaveLength(1);
    expect(notes[0].bySystem).toBe(true);
    expect(notes[0].text).toContain('Status automatisch gewechselt');
    expect(notes[0].text).toContain('Testphase → Zahlend');
    expect(notes[0].text).toContain('14 Tage nach dem Instanzstart');

    const entries = await auditFrom(
      company.id,
      AUDIT_ACTION.companyStatusAutomatic,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].beforeValue).toEqual({ status: 'trial' });
    expect((entries[0].afterValue as { status: string }).status).toBe(
      'paying',
    );
  });

  it('rührt eine Testphase vor Ablauf der 14 Tage nicht an', async () => {
    const company = await createCompany(Prefix, {
      status: 'trial',
      instanceStartDate: day(datePlusDays(today(), -(TRIAL_DAYS - 1))),
    });

    await service.runFrom(Trigger);

    expect(await statusFrom(company.id)).toBe('trial');
    expect(await notesFrom(company.id)).toHaveLength(0);
  });

  it('wechselt genau am 14. Tag nach dem Instanzstart', async () => {
    const company = await createCompany(Prefix, {
      status: 'trial',
      instanceStartDate: day(datePlusDays(today(), -TRIAL_DAYS)),
      priceTier: 'klein',
    });

    await service.runFrom(Trigger);

    expect(await statusFrom(company.id)).toBe('paying');
  });

  it('rührt eine beitragsbefreite Organisation nicht an', async () => {
    const company = await createCompany(Prefix, {
      status: 'exempt',
      instanceStartDate: day(datePlusDays(today(), -(TRIAL_DAYS + 1))),
      priceTier: 'klein',
    });

    await service.runFrom(Trigger);

    expect(await statusFrom(company.id)).toBe('exempt');
    expect(await notesFrom(company.id)).toHaveLength(0);
  });

  it('rührt eine Testphase ohne Instanzstart nicht an', async () => {
    const company = await createCompany(Prefix, {
      status: 'trial',
    });

    await service.runFrom(Trigger);

    expect(await statusFrom(company.id)).toBe('trial');
  });
});

describe('Idempotenz', () => {
  it('wechselt beim ZWEITEN Lauf desselben Tages nicht noch einmal', async () => {
    const company = await ripeTrial();

    const firstRun = await service.runFrom(Trigger);
    const secondRun = await service.runFrom(Trigger);

    expect(firstRun.changed).toBeGreaterThanOrEqual(1);
    // Nach dem ersten Lauf steht die Organisation auf `paying` und taucht
    // gar nicht mehr unter den Fälligen auf.
    expect(await statusFrom(company.id)).toBe('paying');
    expect(await notesFrom(company.id)).toHaveLength(1);
    expect(
      await auditFrom(company.id, AUDIT_ACTION.companyStatusAutomatic),
    ).toHaveLength(1);
    expect(secondRun.day).toBe(today());
  });

  it('wechselt auch bei ZWEI GLEICHZEITIGEN Läufen genau einmal', async () => {
    // Der Fall, der eintritt, wenn zwei Container laufen oder jemand den Lauf
    // von Hand auslöst, während der nächtliche schon arbeitet. Der `runs`-
    // Riegel greift dort NICHT — es trägt allein das bedingte Schreiben.
    for (let round = 0; round < 3; round += 1) {
      const company = await ripeTrial();

      await Promise.all([
        service.runFrom(Trigger),
        service.runFrom(Trigger),
      ]);

      expect(await statusFrom(company.id)).toBe('paying');
      expect(await notesFrom(company.id)).toHaveLength(1);
      expect(
        await auditFrom(
          company.id,
          AUDIT_ACTION.companyStatusAutomatic,
        ),
      ).toHaveLength(1);
    }
  });
});

describe('[H1] Kein automatischer Wechsel ohne Preisvereinbarung', () => {
  it('lässt eine reife Testphase OHNE Preis stehen', async () => {
    // `paying` ist der Status, auf dem Etappe 4 die Rechnungen aufsetzt.
    // Ohne Grundlage darf ihn niemand von allein setzen (R5).
    const company = await createCompany(Prefix, {
      status: 'trial',
      instanceStartDate: day(
        datePlusDays(today(), -(TRIAL_DAYS + 1)),
      ),
    });

    await service.runFrom(Trigger);

    expect(await statusFrom(company.id)).toBe('trial');
    expect(await notesFrom(company.id)).toHaveLength(0);
  });

  it('lässt eine reife Testphase mit leerer Preisstufe stehen', async () => {
    const company = await createCompany(Prefix, {
      status: 'trial',
      priceTier: '',
      instanceStartDate: day(datePlusDays(today(), -(TRIAL_DAYS + 1))),
    });

    await service.runFrom(Trigger);

    expect(await statusFrom(company.id)).toBe('trial');
  });

  it('wechselt, sobald ein abweichender Betrag hinterlegt ist', async () => {
    const company = await createCompany(Prefix, {
      status: 'trial',
      instanceStartDate: day(
        datePlusDays(today(), -(TRIAL_DAYS + 1)),
      ),
      customAmount: 120,
    });

    await service.runFrom(Trigger);

    expect(await statusFrom(company.id)).toBe('paying');
  });
});

describe('Ein Fehler reißt die übrigen nicht mit', () => {
  it('zählt den Fehlschlag und wechselt die anderen trotzdem', async () => {
    const firstIsFail = await ripeTrial();
    const second = await ripeTrial();

    const real = prisma.$transaction.bind(prisma) as (
      arg: unknown,
    ) => Promise<unknown>;
    let firstCall = true;
    const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((
      arg: unknown,
    ) => {
      if (firstCall) {
        firstCall = false;
        return Promise.reject(new Error('absichtlicher Fehler im Test'));
      }
      return real(arg);
    }) as never);

    let result;
    try {
      result = await service.runFrom(Trigger);
    } finally {
      spy.mockRestore();
    }

    expect(result.error).toBe(1);
    expect(result.changed).toBeGreaterThanOrEqual(1);

    const statuses = [
      await statusFrom(firstIsFail.id),
      await statusFrom(second.id),
    ];
    // Genau eine der beiden blieb liegen, die andere wurde gewechselt.
    expect(statuses.filter((s) => s === 'paying').length).toBeGreaterThanOrEqual(1);
    expect(statuses.filter((s) => s === 'trial')).toHaveLength(1);
  });
});

describe('Nachweis des Laufs', () => {
  it('schreibt zu jedem Lauf einen Audit-Eintrag mit Zählwerk', async () => {
    await truncateAuditLog(prisma);
    const result = await service.runFrom(Trigger);

    const runs = await prisma.auditLog.findMany({
      where: { actor: Trigger.actor, action: AUDIT_ACTION.scheduleRun },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].afterValue).toEqual({
      day: result.day,
      checked: result.checked,
      changed: result.changed,
      skipped: result.skipped,
      error: result.error,
    });
  });
});
