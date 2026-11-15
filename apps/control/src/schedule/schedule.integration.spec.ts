import type { ConfigService } from '@nestjs/config';
import { truncateAuditLog } from '../test-support/gobd-cleanup';
import { datePlusDays, today } from '@saas-instant/shared';
import { AuditService, AUDIT_ACTION } from '../audit/audit.service';
import { datePlusMonths } from '../common/calendar';
import {
  PILOT_TO_PAYING_AFTER_DAYS,
  REVIEW_AFTER_MONTHS,
} from '../companies/deadlines';
import { CompanyService } from '../companies/company.service';
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
  sendDouble,
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
const companies = new CompanyService(prisma, audit, sendDouble());

/** Ein Pilot, dessen Instanz vor mehr als 90 Tagen startete. */
async function ripePilot() {
  return createCompany(Prefix, {
    status: 'pilot_running',
    instanceStartDate: day(datePlusDays(today(), -(PILOT_TO_PAYING_AFTER_DAYS + 1))),
    // Ohne Preisvereinbarung wechselt der Zeitplan seit [H1] nicht mehr.
    priceTier: 'klein',
  });
}

/** Eine Organisation, deren Pilotbeschluss mehr als sieben Monate her ist. */
async function ripeReview(status: 'pilot_running' | 'paying') {
  const decision = datePlusMonths(today(), -(REVIEW_AFTER_MONTHS + 1));
  return createCompany(Prefix, {
    status,
    pilotDecisionDate: day(decision),
    reviewDueDate: day(
      datePlusMonths(decision, REVIEW_AFTER_MONTHS),
    ),
  });
}

afterAll(async () => {
  await truncateAuditLog(prisma);
  await cleanUp(Prefix);
  await disconnect();
});

describe('Regel: Pilot läuft → Zahlend nach 90 Tagen', () => {
  it('wechselt und schreibt Notiz samt Audit-Eintrag', async () => {
    const company = await ripePilot();

    await service.runFrom(Trigger);

    expect(await statusFrom(company.id)).toBe('paying');
    const notes = await notesFrom(company.id);
    expect(notes).toHaveLength(1);
    expect(notes[0].bySystem).toBe(true);
    expect(notes[0].text).toContain('Status automatisch gewechselt');
    expect(notes[0].text).toContain('Pilot läuft → Zahlend');
    expect(notes[0].text).toContain('90 Tage nach dem Instanzstart');

    const entries = await auditFrom(
      company.id,
      AUDIT_ACTION.companyStatusAutomatic,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].beforeValue).toEqual({ status: 'pilot_running' });
    expect((entries[0].afterValue as { status: string }).status).toBe(
      'paying',
    );
  });

  it('rührt einen Piloten vor Ablauf der 90 Tage nicht an', async () => {
    const company = await createCompany(Prefix, {
      status: 'pilot_running',
      instanceStartDate: day(datePlusDays(today(), -30)),
    });

    await service.runFrom(Trigger);

    expect(await statusFrom(company.id)).toBe('pilot_running');
    expect(await notesFrom(company.id)).toHaveLength(0);
  });

  it('rührt einen Piloten ohne Instanzstart nicht an', async () => {
    const company = await createCompany(Prefix, {
      status: 'pilot_running',
    });

    await service.runFrom(Trigger);

    expect(await statusFrom(company.id)).toBe('pilot_running');
  });
});

describe('Regel: → Überprüfung offen nach sieben Monaten', () => {
  it('wechselt eine zahlende Organisation', async () => {
    const company = await ripeReview('paying');

    await service.runFrom(Trigger);

    expect(await statusFrom(company.id)).toBe('review_pending');
    const notes = await notesFrom(company.id);
    expect(notes[0].text).toContain('Zahlend → Überprüfung offen');
    expect(notes[0].text).toContain('7 Monate nach dem Pilotbeschluss');
  });

  it('hat Vorrang vor dem Wechsel auf „zahlend" — höchstens EIN Wechsel je Lauf', async () => {
    // Wer beides erfüllt, war lange unbeobachtet. Erst nach „zahlend" und
    // morgen nach „ueberpruefung_offen" zu schieben, erzeugte einen
    // Zwischenstand, den es nie gab — samt zweier Notizen.
    const decision = datePlusMonths(today(), -(REVIEW_AFTER_MONTHS + 1));
    const company = await createCompany(Prefix, {
      status: 'pilot_running',
      instanceStartDate: day(
        datePlusDays(today(), -(PILOT_TO_PAYING_AFTER_DAYS + 1)),
      ),
      pilotDecisionDate: day(decision),
    });

    await service.runFrom(Trigger);

    expect(await statusFrom(company.id)).toBe('review_pending');
    expect(await notesFrom(company.id)).toHaveLength(1);
  });

  it('rührt eine bereits beendete Organisation nicht an', async () => {
    const decision = datePlusMonths(today(), -(REVIEW_AFTER_MONTHS + 1));
    const company = await createCompany(Prefix, {
      status: 'ended',
      pilotDecisionDate: day(decision),
    });

    await service.runFrom(Trigger);

    expect(await statusFrom(company.id)).toBe('ended');
  });
});

describe('Idempotenz', () => {
  it('wechselt beim ZWEITEN Lauf desselben Tages nicht noch einmal', async () => {
    const company = await ripePilot();

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
      const company = await ripePilot();

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
  it('lässt einen reifen Piloten OHNE Preis stehen', async () => {
    // `paying` ist der Status, auf dem Etappe 4 die Rechnungen aufsetzt.
    // Ohne Grundlage darf ihn niemand von allein setzen (R5).
    const company = await createCompany(Prefix, {
      status: 'pilot_running',
      instanceStartDate: day(
        datePlusDays(today(), -(PILOT_TO_PAYING_AFTER_DAYS + 1)),
      ),
    });

    await service.runFrom(Trigger);

    expect(await statusFrom(company.id)).toBe('pilot_running');
    expect(await notesFrom(company.id)).toHaveLength(0);
  });

  it('wechselt, sobald ein abweichender Betrag hinterlegt ist', async () => {
    const company = await createCompany(Prefix, {
      status: 'pilot_running',
      instanceStartDate: day(
        datePlusDays(today(), -(PILOT_TO_PAYING_AFTER_DAYS + 1)),
      ),
      customAmount: 120,
    });

    await service.runFrom(Trigger);

    expect(await statusFrom(company.id)).toBe('paying');
  });
});

describe('[K2] Die Überprüfung lässt sich abschließen', () => {
  it('öffnet sie nach dem Quittieren NICHT wieder — auch nach vielen Läufen', async () => {
    // Vorher: die Fälligkeit hängt an `pilotDecisionDate + 7 Monate`, und
    // dieses Datum wandert nie. Wer den Status zurückstellte, fand ihn am
    // nächsten Morgen wieder auf `review_pending` — jede Nacht, mit zwei
    // Systemnotizen und zwei Audit-Zeilen pro Tag.
    const company = await ripeReview('paying');

    await service.runFrom(Trigger);
    expect(await statusFrom(company.id)).toBe('review_pending');
    const afterFirstRun = (await notesFrom(company.id)).length;

    // Die Betreiberin erledigt die Überprüfung und stellt zurück.
    await companies.statusChange(
      company.id,
      'paying',
      { userId: null, name: 'sam' },
      { ip: null, userAgent: null },
    );

    const receipt = await prisma.company.findUniqueOrThrow({
      where: { id: company.id },
      select: { reviewDoneAt: true },
    });
    expect(receipt.reviewDoneAt).not.toBeNull();

    // Drei weitere Nächte.
    for (let night = 0; night < 3; night += 1) {
      await service.runFrom(Trigger);
      expect(await statusFrom(company.id)).toBe('paying');
    }

    // Genau eine Notiz ist seit dem ersten Lauf dazugekommen: die des
    // Zurückstellens von Hand. Keine einzige aus einem weiteren Nachtlauf.
    expect(await notesFrom(company.id)).toHaveLength(afterFirstRun + 1);
    expect(
      await auditFrom(company.id, AUDIT_ACTION.companyStatusAutomatic),
    ).toHaveLength(1);
  });

  it('öffnet sie erneut, wenn das Beschlussdatum berichtigt wird', async () => {
    // Eine Quittung gehört zu EINER Überprüfung. Wandert der Termin, gilt sie
    // nicht mehr — sonst könnte ein Tippfehler im Beschlussdatum eine
    // Überprüfung dauerhaft verschwinden lassen.
    const company = await ripeReview('paying');
    await service.runFrom(Trigger);
    await companies.statusChange(
      company.id,
      'paying',
      { userId: null, name: 'sam' },
      { ip: null, userAgent: null },
    );
    await service.runFrom(Trigger);
    expect(await statusFrom(company.id)).toBe('paying');

    // Beschluss lag in Wahrheit noch weiter zurück -> neuer, früherer Termin
    // NACH der Quittung? Nein: späterer Termin, Quittung liegt davor.
    await prisma.company.update({
      where: { id: company.id },
      data: {
        pilotDecisionDate: day(
          datePlusMonths(today(), -(REVIEW_AFTER_MONTHS + 24)),
        ),
      },
    });
    // Quittung auf einen Tag VOR dem (nun viel früheren) Termin setzen.
    await prisma.company.update({
      where: { id: company.id },
      data: { reviewDoneAt: day('2020-01-01') },
    });

    await service.runFrom(Trigger);
    expect(await statusFrom(company.id)).toBe('review_pending');
  });
});

describe('Ein Fehler reißt die übrigen nicht mit', () => {
  it('zählt den Fehlschlag und wechselt die anderen trotzdem', async () => {
    const firstIsFail = await ripePilot();
    const second = await ripePilot();

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
    expect(statuses.filter((s) => s === 'pilot_running')).toHaveLength(1);
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
