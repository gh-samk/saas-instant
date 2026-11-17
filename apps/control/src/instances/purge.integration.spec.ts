import { ConfigService } from '@nestjs/config';
import type { CompanyStatus } from '.prisma/control-client';
import { randomUUID } from 'node:crypto';
import { PURGE_DAYS, datePlusDays, today, toDate } from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import { CompanyService } from '../companies/company.service';
import { performStatusChange } from '../companies/status-change';
import { CoolifyProvisioner } from '../coolify/coolify.provisioner';
import type { MailService } from '../mail/mail.service';
import type { VaultService } from '../vault/vault.service';
import { CoolifyMock } from '../test-support/coolify-mock';
import {
  createCompany,
  disconnect,
  newPrefix,
  prisma,
  sendDouble,
} from '../test-support/company-provisioning';
import { truncateInvoices } from '../test-support/gobd-cleanup';
import { BackupPlanService } from './backup-plan.service';
import { BackupService } from './backup.service';
import { PurgeService } from './purge.service';
import { purgeFailed } from '../tasks/sources/purge-failed.source';

/**
 * Löschung 90 Tage nach der Archivierung gegen eine ECHTE Datenbank, mit
 * Attrappe von Coolify. Geprüft: Reihenfolge, Warten auf den Agenten, Teilfehler,
 * zweiter Lauf ohne Folgen, completeDelete gegen contactDataDelete, Rechnungen
 * bleiben, Warnmails je Frist einmal, Schalter, gesperrter Tresor, nur beendete
 * Organisationen, wiederholbarer Organisationsschritt, Übernahme-Rennen.
 */
jest.setTimeout(60_000);

const PREFIX = newPrefix('purge');
const ADMIN = `${PREFIX}@example.test`;
const audit = new AuditService(prisma);
const companies = new CompanyService(prisma, audit, sendDouble());

let coolify: CoolifyMock;
let warnings: { email: string; subdomain: string; day: string; daysLeft: number }[];
let ready: boolean;
let env: Record<string, string>;
const created: { companyIds: string[]; instanceIds: string[] } = { companyIds: [], instanceIds: [] };

function build(): PurgeService {
  const config = { get: (key: string, fallback?: string) => env[key] ?? fallback } as unknown as ConfigService;
  const vault = { isReady: () => ready } as unknown as VaultService;
  const mail = {
    sendPurgeWarning: async (email: string, subdomain: string, day: string, daysLeft: number) => {
      warnings.push({ email, subdomain, day, daysLeft });
    },
  } as unknown as MailService;
  return new PurgeService(
    prisma,
    audit,
    config,
    vault,
    mail,
    companies,
    new CoolifyProvisioner(coolify, async () => undefined),
  );
}

async function archived(
  label: string,
  opts: { daysAgo: number; invoice?: boolean; app?: boolean; status?: CompanyStatus; endedDaysAgo?: number } = { daysAgo: PURGE_DAYS },
) {
  const status = opts.status ?? 'ended';
  const company = await createCompany(PREFIX, {
    status,
    endedAt: status === 'ended' ? toDate(datePlusDays(today(), -(opts.endedDaysAgo ?? opts.daysAgo))) : null,
  });
  const subdomain = `${label}-${randomUUID().slice(0, 6)}`;
  const application = opts.app === false ? null : coolify.setUp(`instance-${subdomain}`, `${subdomain}.example.com`, 'exited');
  const instance = await prisma.instance.create({
    data: {
      companyId: company.id,
      subdomain,
      status: 'archived',
      archivedAt: toDate(datePlusDays(today(), -opts.daysAgo)),
      coolifyApplicationId: application?.uuid ?? null,
    },
  });
  const backup = await prisma.backup.create({
    data: { instanceId: instance.id, date: toDate(datePlusDays(today(), -100)), sizeBytes: BigInt(10) },
  });
  await prisma.metric.create({ data: { instanceId: instance.id, date: toDate(datePlusDays(today(), -100)) } });
  await prisma.instanceRestore.create({
    data: { instanceId: instance.id, backupId: backup.id, newSubdomain: `${subdomain}-r`, status: 'failed' },
  });
  if (opts.invoice) {
    await prisma.invoice.create({
      data: {
        companyId: company.id,
        invoiceDate: new Date('2026-05-01'),
        servicePeriodFrom: new Date('2026-05-01'),
        servicePeriodUntil: new Date('2026-05-31'),
        dueDate: new Date('2026-05-15'),
        recipientName: `${PREFIX} Empfänger`,
        recipientAddress: 'Musterstraße 1',
        issuerCompanyName: 'Aussteller GmbH',
        issuerAddress: 'Ausstellerweg 2',
      },
    });
  }
  created.companyIds.push(company.id);
  created.instanceIds.push(instance.id);
  return { company, instance, subdomain, application };
}

/** Der Agent hat das Präfix geleert und es über den Meldeweg bestätigt. */
async function confirmByAgent(subdomain: string): Promise<void> {
  const backups = new BackupService(prisma, audit);
  await backups.report({ subdomain, kind: 'purged', date: today(), sizeBytes: 0 }, null);
}

const exists = async (id: string) => (await prisma.instance.count({ where: { id } })) > 0;

beforeAll(async () => {
  await prisma.user.create({ data: { name: 'Purge-Test', username: PREFIX, email: ADMIN } });
});

beforeEach(async () => {
  coolify = new CoolifyMock();
  warnings = [];
  ready = true;
  env = {};
  await prisma.backupTarget.deleteMany();
  await prisma.backupTarget.create({
    data: { type: 's3', schedule: 'daily', retentionDays: 30 },
  });
});

afterAll(async () => {
  await prisma.backupTarget.deleteMany();
  for (const id of created.instanceIds) {
    await prisma.instanceRestore.deleteMany({ where: { instanceId: id } });
    await prisma.backup.deleteMany({ where: { instanceId: id } });
    await prisma.metric.deleteMany({ where: { instanceId: id } });
    await prisma.instance.deleteMany({ where: { id } });
  }
  await truncateInvoices(prisma);
  await prisma.note.deleteMany({ where: { companyId: { in: created.companyIds } } });
  await prisma.company.deleteMany({ where: { id: { in: created.companyIds } } });
  await prisma.user.deleteMany({ where: { username: PREFIX } });
  await disconnect();
});

describe('Löschung nach 90 Tagen', () => {
  it('geht der Reihenfolge nach: Coolify, Warten auf den Agenten, dann Zeilen und Organisation', async () => {
    const a = await archived('reihenfolge');
    const service = build();

    // Lauf 1: Coolify wird gelöscht (mit Volumes), der Agent hat noch nichts bestätigt: alles andere bleibt.
    const first = await service.run();
    expect(coolify.deleted).toEqual([{ uuid: a.application!.uuid, deleteVolumes: true }]);
    expect(first.waiting).toBeGreaterThanOrEqual(1);
    expect(await exists(a.instance.id)).toBe(true);
    expect(await prisma.backup.count({ where: { instanceId: a.instance.id } })).toBe(1);
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: a.instance.id } })).coolifyApplicationId).toBeNull();

    // Jetzt steht die Instanz im Plan des Agenten — und erst jetzt.
    const plan = new BackupPlanService(prisma, { provisioning: { backup: null }, billing: {} } as never, build());
    expect(await plan.subdomainsDue()).toContain(a.subdomain);

    await confirmByAgent(a.subdomain);
    const second = await service.run();
    expect(second.purged).toBeGreaterThanOrEqual(1);
    expect(await exists(a.instance.id)).toBe(false);
    expect(await prisma.backup.count({ where: { instanceId: a.instance.id } })).toBe(0);
    expect(await prisma.metric.count({ where: { instanceId: a.instance.id } })).toBe(0);
    expect(await prisma.instanceRestore.count({ where: { instanceId: a.instance.id } })).toBe(0);
    // Ohne Rechnungen verschwindet die Organisation ganz (completeDelete).
    expect(await prisma.company.count({ where: { id: a.company.id } })).toBe(0);
  });

  it('ein zweiter Lauf hat keine Folgen', async () => {
    const a = await archived('zweimal');
    const service = build();
    await service.run();
    await confirmByAgent(a.subdomain);
    await service.run();
    const deletedBefore = coolify.deleted.length;
    const again = await service.run();
    expect(coolify.deleted.length).toBe(deletedBefore);
    expect(again.error).toBe(0);
    expect(await exists(a.instance.id)).toBe(false);
  });

  it('mit Rechnungen bleibt die Hülle (contactDataDelete), Rechnungen unangetastet, Audit ohne Klarnamen', async () => {
    const a = await archived('rechnung', { daysAgo: PURGE_DAYS, invoice: true });
    const service = build();
    await service.run();
    await confirmByAgent(a.subdomain);
    await service.run();

    expect(await exists(a.instance.id)).toBe(false);
    const company = await prisma.company.findUniqueOrThrow({ where: { id: a.company.id } });
    expect(company.name).not.toContain(PREFIX);
    expect(await prisma.invoice.count({ where: { companyId: a.company.id } })).toBe(1);

    const entries = await prisma.auditLog.findMany({
      where: { OR: [{ objectId: a.instance.id }, { objectId: a.company.id }] },
    });
    expect(entries.map((e) => e.action)).toEqual(
      expect.arrayContaining([AUDIT_ACTION.instancePurged, AUDIT_ACTION.companyContactDataDeleted]),
    );
    expect(JSON.stringify(entries)).not.toContain(a.company.name);
  });

  it('ein Teilfehler (Coolify) lässt den Rest stehen und der nächste Lauf macht weiter', async () => {
    const a = await archived('teilfehler');
    const b = await archived('anderer');
    coolify.failsAt = 'deleteApplication';
    const service = build();
    const failed = await service.run();
    expect(failed.error).toBeGreaterThanOrEqual(2);
    expect(await exists(a.instance.id)).toBe(true);
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: a.instance.id } })).coolifyApplicationId).toBe(a.application!.uuid);
    expect(await prisma.backup.count({ where: { instanceId: a.instance.id } })).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { action: AUDIT_ACTION.instancePurgeFailed, objectId: b.instance.id } }),
    ).toBe(1);

    coolify.failsAt = null;
    await service.run();
    expect(coolify.deleted.map((d) => d.uuid)).toEqual(expect.arrayContaining([a.application!.uuid, b.application!.uuid]));
  });

  it('Coolify kennt die Anwendung nicht mehr (404): gilt als erledigt', async () => {
    const a = await archived('schonweg');
    coolify.removeManually(a.application!.uuid);
    await build().run();
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: a.instance.id } })).coolifyApplicationId).toBeNull();
  });

  it('ohne Sicherungsziel entfällt das Warten auf den Agenten', async () => {
    await prisma.backupTarget.deleteMany();
    const a = await archived('ohneziel');
    await build().run();
    expect(await exists(a.instance.id)).toBe(false);
  });

  it('eine Instanz vor Ablauf der Frist wird nicht angefasst', async () => {
    const a = await archived('frisch', { daysAgo: PURGE_DAYS - 1 });
    await build().run();
    expect(coolify.deleted).toEqual([]);
    expect(await exists(a.instance.id)).toBe(true);
  });

  it('der Plan nennt vor der Coolify-Löschung und vor Ablauf der Frist nichts', async () => {
    const early = await archived('planfrueh', { daysAgo: PURGE_DAYS - 1, app: false });
    const withApp = await archived('planapp');
    const plan = new BackupPlanService(prisma, { provisioning: { backup: null }, billing: {} } as never, build());
    const due = await plan.subdomainsDue();
    expect(due).not.toContain(early.subdomain);
    expect(due).not.toContain(withApp.subdomain);
  });

  it('die Bestätigung des Agenten zählt nur für fällige Instanzen mit gelöschter Anwendung', async () => {
    const early = await archived('bestfrueh', { daysAgo: 10, app: false });
    const withApp = await archived('bestapp');
    await confirmByAgent(early.subdomain);
    await confirmByAgent(withApp.subdomain);
    expect(
      await prisma.auditLog.count({
        where: { action: AUDIT_ACTION.instanceStoragePurged, objectId: { in: [early.instance.id, withApp.instance.id] } },
      }),
    ).toBe(0);
  });

  it('CONTROL_PURGE_ENABLED=nein schaltet ab; ein gesperrter Tresor lässt den Lauf still warten', async () => {
    const a = await archived('schalter');
    env['CONTROL_PURGE_ENABLED'] = 'nein';
    await expect(build().dailyRun()).resolves.toBeUndefined();
    expect(coolify.deleted).toEqual([]);

    env = {};
    ready = false;
    await expect(build().dailyRun()).resolves.toBeUndefined();
    expect(coolify.deleted).toEqual([]);
    expect(await exists(a.instance.id)).toBe(true);

    ready = true;
    await build().dailyRun();
    expect(coolify.deleted.map((d) => d.uuid)).toContain(a.application!.uuid);
  });

  it('warnt 14 und 3 Tage vorher, je Frist genau einmal, nur mit Subdomain und Datum', async () => {
    const a = await archived('warnung', { daysAgo: PURGE_DAYS - 14 });
    const service = build();
    const mine = () => warnings.filter((w) => w.email === ADMIN && w.subdomain === a.subdomain);

    await service.run();
    await service.run();
    expect(mine()).toHaveLength(1);
    expect(mine()[0]).toMatchObject({ daysLeft: 14 });
    expect(JSON.stringify(mine()[0])).not.toContain(a.company.name);

    // Elf Tage später: die 3-Tage-Frist ist erreicht.
    await prisma.instance.update({
      where: { id: a.instance.id },
      data: { archivedAt: toDate(datePlusDays(today(), -(PURGE_DAYS - 3))) },
    });
    await prisma.company.update({
      where: { id: a.company.id },
      data: { endedAt: toDate(datePlusDays(today(), -(PURGE_DAYS - 3))) },
    });
    await service.run();
    await service.run();
    expect(mine().map((w) => w.daysLeft)).toEqual([14, 3]);
    expect(coolify.deleted).toEqual([]);
  });

  it('scheitert der Versand für alle, gilt die Frist nicht als erledigt', async () => {
    const a = await archived('versand', { daysAgo: PURGE_DAYS - 3 });
    const config = { get: (_k: string, f?: string) => f } as unknown as ConfigService;
    const failing = new PurgeService(
      prisma,
      audit,
      config,
      { isReady: () => true } as unknown as VaultService,
      { sendPurgeWarning: async () => { throw new Error('Relay nicht erreichbar'); } } as unknown as MailService,
      companies,
      new CoolifyProvisioner(coolify, async () => undefined),
    );
    await failing.run();
    expect(await prisma.auditLog.count({ where: { action: AUDIT_ACTION.instancePurgeWarned3, objectId: a.instance.id } })).toBe(0);
    await build().run();
    expect(await prisma.auditLog.count({ where: { action: AUDIT_ACTION.instancePurgeWarned3, objectId: a.instance.id } })).toBe(1);
  });

  it('die Aufgabe „Löschung fehlgeschlagen" erscheint erst nach der Karenz', async () => {
    const late = await archived('aufgabespaet', { daysAgo: PURGE_DAYS + 3 });
    const fresh = await archived('aufgabefrisch', { daysAgo: PURGE_DAYS });
    const result = await purgeFailed.collect({ prisma, todayDay: today(), limit: 1000 } as never);
    const ids = result.tasks.map((t) => t.company?.id);
    expect(ids).toContain(late.company.id);
    expect(ids).not.toContain(fresh.company.id);
    expect(result.tasks.every((t) => t.kind === 'purge_failed')).toBe(true);
  });

  it('eine nicht beendete Organisation wird weder gewarnt noch gelöscht, steht aber als Aufgabe da; nach „Beendet“ läuft die Löschung', async () => {
    const warn = await archived('offenwarn', { daysAgo: PURGE_DAYS - 3, status: 'paying' });
    const a = await archived('offen', { daysAgo: PURGE_DAYS + 3, status: 'paying' });
    const service = build();
    const result = await service.run();
    expect(result.purged).toBe(0);
    expect(warnings.some((w) => w.subdomain === warn.subdomain)).toBe(false);
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: a.instance.id } })).coolifyApplicationId).toBe(a.application!.uuid);

    // Weder der Plan noch die Annahme von `purged` kennen sie.
    const plan = new BackupPlanService(prisma, { provisioning: { backup: null }, billing: {} } as never, service);
    expect(await plan.subdomainsDue()).not.toContain(a.subdomain);
    await confirmByAgent(a.subdomain);
    expect(await prisma.auditLog.count({ where: { action: AUDIT_ACTION.instanceStoragePurged, objectId: a.instance.id } })).toBe(0);

    // Sichtbar als „Löschung fehlgeschlagen" mit passendem Text.
    const tasks = await purgeFailed.collect({ prisma, todayDay: today(), limit: 1000 } as never);
    const task = tasks.tasks.find((t) => t.company?.id === a.company.id);
    expect(task?.reason).toContain('nicht beendet');

    await prisma.company.update({
      where: { id: a.company.id },
      data: { status: 'ended', endedAt: toDate(datePlusDays(today(), -PURGE_DAYS)) },
    });
    await service.run();
    await confirmByAgent(a.subdomain);
    await service.run();
    expect(await exists(a.instance.id)).toBe(false);
  });

  it('eine erst kürzlich beendete Organisation wird nicht gelöscht, auch wenn die Instanz lange archiviert ist; ein Neustart setzt die Frist zurück', async () => {
    const a = await archived('kuerzlich', { daysAgo: PURGE_DAYS + 30, endedDaysAgo: PURGE_DAYS - 1 });
    const service = build();
    await service.run();
    const stays = () => prisma.instance.findUniqueOrThrow({ where: { id: a.instance.id } });
    expect((await stays()).coolifyApplicationId).toBe(a.application!.uuid);
    // Keine Aufgabe: sie wartet nur auf die Frist der Organisation.
    const tasks = await purgeFailed.collect({ prisma, todayDay: today(), limit: 1000 } as never);
    expect(tasks.tasks.map((t) => t.company?.id)).not.toContain(a.company.id);

    // Beendet seit 90 Tagen, dann neu gestartet und wieder beendet: die Frist beginnt neu.
    await prisma.company.update({ where: { id: a.company.id }, data: { endedAt: toDate(datePlusDays(today(), -PURGE_DAYS)) } });
    const change = (fromStatus: CompanyStatus, afterStatus: CompanyStatus) =>
      performStatusChange(prisma, audit, {
        companyId: a.company.id,
        fromStatus,
        afterStatus,
        action: AUDIT_ACTION.companyStatusChanged,
        actor: 'test',
        userId: null,
        introduction: 'Status gewechselt',
      });
    await change('ended', 'trial');
    expect((await prisma.company.findUniqueOrThrow({ where: { id: a.company.id } })).endedAt).toBeNull();
    await change('trial', 'ended');
    expect((await prisma.company.findUniqueOrThrow({ where: { id: a.company.id } })).endedAt).not.toBeNull();
    await service.run();
    expect((await stays()).coolifyApplicationId).toBe(a.application!.uuid);
    expect(await exists(a.instance.id)).toBe(true);
  });

  it('scheitert der Organisationsschritt, bleibt die Instanz stehen und die nächste Nacht wiederholt ihn', async () => {
    const a = await archived('orgfehler');
    const service = build();
    await service.run();
    await confirmByAgent(a.subdomain);

    const spy = jest.spyOn(companies, 'completeDelete').mockRejectedValueOnce(new Error('Datenbank weg'));
    const failed = await service.run();
    expect(failed.error).toBeGreaterThanOrEqual(1);
    // Alles in einer Transaktion: nichts davon ist verloren.
    expect(await exists(a.instance.id)).toBe(true);
    expect(await prisma.backup.count({ where: { instanceId: a.instance.id } })).toBe(1);
    expect(await prisma.company.count({ where: { id: a.company.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: AUDIT_ACTION.instancePurged, objectId: a.instance.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: AUDIT_ACTION.instancePurgeFailed, objectId: a.instance.id } })).toBe(1);
    const task = await purgeFailed.collect({ prisma, todayDay: datePlusDays(today(), 3), limit: 1000 } as never);
    expect(task.tasks.map((t) => t.company?.id)).toContain(a.company.id);

    spy.mockRestore();
    const again = await service.run();
    expect(again.purged).toBeGreaterThanOrEqual(1);
    expect(await exists(a.instance.id)).toBe(false);
    expect(await prisma.company.count({ where: { id: a.company.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: AUDIT_ACTION.instancePurged, objectId: a.instance.id } })).toBe(1);
  });

  it('Übernahme-Rennen: eine Instanz, die nach der Auswahl nicht mehr archiviert ist, wird nicht angefasst', async () => {
    const a = await archived('rennen');
    await prisma.instance.update({ where: { id: a.instance.id }, data: { status: 'active', archivedAt: null } });
    const outcome = await (build() as unknown as { process(due: { id: string }): Promise<string> }).process({ id: a.instance.id });
    expect(outcome).toBe('waiting');
    expect(coolify.deleted).toEqual([]);
    expect(await exists(a.instance.id)).toBe(true);
    expect(await prisma.backup.count({ where: { instanceId: a.instance.id } })).toBe(1);
  });

  it('Neustart zwischen Auswahl und Transaktion: die Organisation wird gesperrt und neu geprüft, nichts wird gelöscht', async () => {
    const a = await archived('neustart');
    await confirmByAgent(a.subdomain);
    // Der Statuswechsel auf „trial“ kommt genau nach der Bestätigung, vor der Löschtransaktion.
    const count = prisma.backupTarget.count.bind(prisma.backupTarget);
    const spy = jest.spyOn(prisma.backupTarget, 'count').mockImplementationOnce((async (...args: unknown[]) => {
      await performStatusChange(prisma, audit, {
        companyId: a.company.id,
        fromStatus: 'ended',
        afterStatus: 'trial',
        action: AUDIT_ACTION.companyStatusChanged,
        actor: 'test',
        userId: null,
        introduction: 'Status gewechselt',
      });
      return (count as (...a: unknown[]) => unknown)(...args);
    }) as never);
    const result = await build().run();
    spy.mockRestore();
    expect(result.purged).toBe(0);
    expect(await exists(a.instance.id)).toBe(true);
    expect(await prisma.backup.count({ where: { instanceId: a.instance.id } })).toBe(1);
    expect(await prisma.company.count({ where: { id: a.company.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: AUDIT_ACTION.instancePurged, objectId: a.instance.id } })).toBe(0);
  });

  it('der Plan nennt nichts, solange die Löschung abgeschaltet oder der Tresor gesperrt ist', async () => {
    const a = await archived('planschalter', { daysAgo: PURGE_DAYS, app: false });
    const manifest = { provisioning: { backup: null }, billing: {} } as never;
    expect((await new BackupPlanService(prisma, manifest, build()).response()).purge).toContain(a.subdomain);
    ready = false;
    expect((await new BackupPlanService(prisma, manifest, build()).response()).purge).toEqual([]);
    ready = true;
    env['CONTROL_PURGE_ENABLED'] = 'nein';
    expect((await new BackupPlanService(prisma, manifest, build()).response()).purge).toEqual([]);
  });

  it('ein Fehler beim Warn-Eintrag bricht den Lauf nicht ab', async () => {
    await archived('warnaudit', { daysAgo: PURGE_DAYS - 14 });
    const b = await archived('nebenan');
    const flaky = Object.create(audit) as AuditService;
    flaky.log = async (entry, db) => {
      if (entry.action === AUDIT_ACTION.instancePurgeWarned14) throw new Error('Protokoll nicht erreichbar');
      return audit.log(entry, db);
    };
    const config = { get: (_k: string, f?: string) => f } as unknown as ConfigService;
    const service = new PurgeService(
      prisma,
      flaky,
      config,
      { isReady: () => true } as unknown as VaultService,
      { sendPurgeWarning: async () => undefined } as unknown as MailService,
      companies,
      new CoolifyProvisioner(coolify, async () => undefined),
    );
    await expect(service.run()).resolves.toBeDefined();
    expect(coolify.deleted.map((d) => d.uuid)).toContain(b.application!.uuid);
  });
});
