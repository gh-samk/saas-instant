import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { today } from '@saas-instant/shared';
import { AuditService } from '../audit/audit.service';
import { BackupAgentClient } from '../backup-settings/backup-agent.client';
import { BackupAgentUnavailableError } from '../backup-settings/backup-agent.errors';
import { BackupSettingsService } from '../backup-settings/backup-settings.service';
import { CoolifyConfigService } from '../coolify/coolify.config';
import { CoolifyProvisioner } from '../coolify/coolify.provisioner';
import { CryptoService } from '../crypto/crypto.service';
import type { ManifestService } from '../manifest/manifest.service';
import { FakeBackupAgent } from '../test-support/fake-backup-agent';
import { captureLogs } from '../test-support/log-capture';
import { CoolifyMock } from '../test-support/coolify-mock';
import {
  cleanUp,
  createCompany,
  disconnect,
  newPrefix,
  prisma,
  waitUntil,
} from '../test-support/company-provisioning';
import { BackupPlanService } from './backup-plan.service';
import { BackupService } from './backup.service';
import { InstanceBackupService } from './instance-backup.service';
import { InstanceProvisioningService } from './instance-provisioning.service';
import { InstanceRestoreService, type RestoreView } from './instance-restore.service';
import {
  AdoptStopFailedError,
  RestoreConfirmationError,
  RestoreInProgressError,
  RestoreNotAdoptableError,
} from './instance-restore.errors';
import { SubdomainTakenError } from './instance.errors';
import { InstanceService } from './instance.service';
import type { RestoreStartDto } from './dto/instance-backup.dto';

/**
 * Sicherung und Wiederherstellung gegen eine ECHTE Datenbank, mit
 * Attrappe des Agents (node:http) und Attrappe von Coolify.
 *
 * Geprüft wird, was die Verwaltung zusagt: Meldeweg mit kind/objectKey,
 * Sicherungsplan ohne Geheimnisse, Wiederherstellung als NEUE Anwendung
 * (keine zweite Instanz-Zeile), der private Schlüssel nirgends gespeichert,
 * Übernahme atomar, die alte Instanz GESTOPPT und NICHTS gelöscht.
 */
jest.setTimeout(60_000);

const PREFIX = newPrefix('teilf-sicherung');
const ACTOR = { userId: null, name: 'sam' };
// Kein echtes Konto nötig: `userId` im Audit-Log darf leer sein.
const TEST_USER = { id: null as unknown as string, username: 'sam' };
const SOURCE = { ip: '203.0.113.9', userAgent: 'Jest-Integration' };
const AGENT_SECRET = 'agent-secret-0123456789abcdef0123456789abcdef';
const AGE_IDENTITY = 'AGE-SECRET-KEY-1ZYXWVUTSRQPNMLKJHGFEDCBA9876543210ZYXWVUTSRQPNMLKJHG';
const OLD_TOKENS = { metrics: 'alt-metrics-token-1234567890', setup: 'alt-setup-token-1234567890' };

const config = new ConfigService({
  COOLIFY_TOKEN: 'attrappe-token-mindestens-32-zeichen-lang',
  CONTROL_INSTANCE_BASE_DOMAIN: 'example.com',
  CONTROL_INSTANCE_SMTP_HOST: 'mail.example.com',
  CONTROL_INSTANCE_SMTP_USER: 'noreply@example.com',
  CONTROL_INSTANCE_SMTP_PASS: 'attrappe-passwort',
  CONTROL_INSTANCE_SMTP_FROM: 'Mein Produkt <noreply@example.com>',
});
const coolifyConfig = new CoolifyConfigService(config);
const audit = new AuditService(prisma);
const crypto = new CryptoService({
  get: () => 'test-schluessel-mindestens-32-zeichen-lang-x',
} as never);
const manifest = {
  provisioning: {
    backup: {
      dbServiceName: 'db',
      dbName: 'app',
      dbUser: 'app',
      uploadsService: 'app',
      uploadsPath: '/app/uploads',
      composeProjectPattern: 'proj-{applicationId}',
    },
  },
} as unknown as ManifestService;

let agent: FakeBackupAgent;
let agentUrl: string;

function suffix(): string {
  return randomUUID().slice(0, 8);
}

function build() {
  const coolify = new CoolifyMock();
  const provisioner = new CoolifyProvisioner(coolify, async () => undefined);
  const noWait = async () => undefined;
  const provisioning = new InstanceProvisioningService(
    prisma,
    audit,
    coolifyConfig,
    provisioner,
    noWait,
    async () => true,
  );
  const instances = new InstanceService(prisma, audit, crypto, coolifyConfig, provisioning, provisioner);
  const client = new BackupAgentClient(
    new ConfigService({ BACKUP_AGENT_URL: agentUrl, BACKUP_AGENT_SECRET: AGENT_SECRET }),
  );
  const restores = new InstanceRestoreService(
    prisma,
    audit,
    coolifyConfig,
    provisioner,
    noWait,
    async () => true,
    crypto,
    instances,
    client,
    manifest,
  );
  const backups = new InstanceBackupService(prisma, audit, client, manifest);
  return { coolify, restores, backups, client };
}

/** Eine aktive Instanz mit alter Anwendung und einer gemeldeten Sicherung. */
async function withInstanceAndBackup(coolify: CoolifyMock) {
  const company = await createCompany(PREFIX);
  const subdomain = `rs-${suffix()}`;
  const old = coolify.setUp(`instanz-${subdomain}`, `${subdomain}.example.com`);
  const instance = await prisma.instance.create({
    data: {
      companyId: company.id,
      subdomain,
      status: 'active',
      coolifyApplicationId: old.uuid,
      metricsTokenEncrypted: crypto.encrypt(OLD_TOKENS.metrics),
      setupTokenEncrypted: crypto.encrypt(OLD_TOKENS.setup),
    },
  });
  const objectKey = `si/instances/${subdomain}/2026-11-14T023000Z.dump.age`;
  await new BackupService(prisma, audit).report(
    { subdomain, kind: 'instance', date: today(), sizeBytes: 12345, objectKey, sha256: 'b'.repeat(64) },
    null,
  );
  const backup = await prisma.backup.findFirstOrThrow({ where: { instanceId: instance.id } });
  return { company, instance, old, objectKey, backup };
}

function dto(backupId: string, instanceName: string, extra: Partial<RestoreStartDto> = {}): RestoreStartDto {
  return {
    backupId,
    newSubdomain: `rs-neu-${suffix()}`,
    ageIdentity: AGE_IDENTITY,
    confirmName: instanceName,
    ...extra,
  } as RestoreStartDto;
}

async function wipe(): Promise<void> {
  // Der Name ist verschlüsselt: im Speicher auswählen.
  const all = await prisma.instance.findMany({
    select: { id: true, company: { select: { name: true } } },
  });
  const ours = all.filter((i) => i.company.name.startsWith('teilf-sicherung'));
  await prisma.instanceRestore.deleteMany({ where: { instanceId: { in: ours.map((i) => i.id) } } });
  await cleanUp('teilf-sicherung');
}

beforeAll(async () => {
  agent = new FakeBackupAgent(AGENT_SECRET);
  agentUrl = await agent.start();
  await wipe();
});

afterAll(async () => {
  await agent.stop();
  await prisma.backupTarget.deleteMany({});
  await wipe();
  await disconnect();
});

describe('Sicherungsziel (Einstellungen) gegen die echte Datenbank', () => {
  it('speichert nur Metadaten, vermerkt den Test und lässt keine Geheimnisse zurück', async () => {
    await prisma.backupTarget.deleteMany({});
    const client = new BackupAgentClient(
      new ConfigService({ BACKUP_AGENT_URL: agentUrl, BACKUP_AGENT_SECRET: AGENT_SECRET }),
    );
    const settings = new BackupSettingsService(prisma, audit, client);
    const logs = captureLogs();
    try {
      const before = await settings.get();
      expect(before.target).toBeNull();

      agent.putTargetReply = { ok: true, ageRecipient: 'age1abc', ageIdentity: AGE_IDENTITY };
      const dtoBody = {
        type: 's3',
        schedule: 'twice_daily',
        retentionDays: 45,
        objectLock: true,
        s3: {
          endpoint: 'https://s3.example.com',
          region: 'eu-central-1',
          bucket: 'sicherung',
          prefix: 'si',
          pathStyle: true,
          accessKeyId: 'GEHEIME-KENNUNG-XYZ',
          secretAccessKey: 'GEHEIMER-SCHLUESSEL-XYZ',
        },
      };
      const saved = await settings.update(dtoBody as never, TEST_USER, SOURCE);
      expect(saved.ageIdentity).toBe(AGE_IDENTITY);
      const tested = await settings.test(TEST_USER, SOURCE);
      expect(tested.ok).toBe(true);

      const row = await prisma.backupTarget.findUniqueOrThrow({ where: { id: 'singleton' } });
      expect(row).toMatchObject({
        type: 's3',
        endpoint: 'https://s3.example.com',
        bucket: 'sicherung',
        schedule: 'twice_daily',
        retentionDays: 45,
        lastTestOk: true,
      });
      expect(row.lastTestAt).not.toBeNull();
      const audits = await prisma.auditLog.findMany({
        where: { action: { in: ['backup.target_updated', 'backup.target_tested'] } },
      });
      expect(audits.map((a) => a.action).sort()).toEqual(['backup.target_tested', 'backup.target_updated']);
      const everything = JSON.stringify({ row, audits, logs: logs.lines, get: await settings.get() });
      for (const secret of ['GEHEIME-KENNUNG-XYZ', 'GEHEIMER-SCHLUESSEL-XYZ', AGE_IDENTITY]) {
        expect(everything).not.toContain(secret);
      }
    } finally {
      logs.restore();
      agent.putTargetReply = { ok: true, ageRecipient: 'age1testempfaenger' };
    }
  });
});

describe('Meldeweg und Sicherungsplan', () => {
  it('speichert kind, objectKey und sha256; control/invoices stehen nur im Audit-Log', async () => {
    const { coolify } = build();
    const { backup, objectKey, instance } = await withInstanceAndBackup(coolify);
    expect(backup).toMatchObject({ kind: 'instance', objectKey, sha256: 'b'.repeat(64), status: 'ok', verifiedAt: null });

    const service = new BackupService(prisma, audit);
    await service.report({ kind: 'control', date: today(), sizeBytes: 5, objectKey: 'si/control/x.dump.age' }, null);
    await service.report({ kind: 'invoices', date: today(), sizeBytes: 6, objectKey: 'si/invoices/2026/x.tar.age' }, null);
    expect(await prisma.backup.count({ where: { instanceId: instance.id } })).toBe(1);
    const reports = await prisma.auditLog.findMany({ where: { action: 'backup.reported' } });
    const kinds = reports.map((r) => (r.afterValue as { kind?: string } | null)?.kind);
    expect(kinds).toEqual(expect.arrayContaining(['control', 'invoices']));
  });

  it('der Plan nennt aktive Instanzen mit Compose-Projekt und ohne Geheimnisse', async () => {
    const { coolify } = build();
    const { instance, old } = await withInstanceAndBackup(coolify);
    const plan = await new BackupPlanService(prisma, manifest).plan();
    const entry = plan.find((p) => p.subdomain === instance.subdomain);
    expect(entry).toEqual({
      subdomain: instance.subdomain,
      composeProject: `proj-${old.uuid}`,
      dbService: 'db',
      dbName: 'app',
      dbUser: 'app',
      uploadsService: 'app',
      uploadsPath: '/app/uploads',
    });
    expect(JSON.stringify(plan)).not.toMatch(/token|passwor|secret/i);
    const none = await new BackupPlanService(prisma, { provisioning: { backup: null } } as never).plan();
    expect(none).toEqual([]);
  });

  it('die Antwort des Plans trägt die Aufbewahrungsfrist (Manifest, sonst 8) und die Instanzen', async () => {
    const { coolify } = build();
    const { instance } = await withInstanceAndBackup(coolify);
    const withYears = { ...manifest, billing: { retentionYears: 10 } } as never;
    const answer = await new BackupPlanService(prisma, withYears).response();
    expect(answer.retentionYears).toBe(10);
    expect(Array.isArray(answer.instances)).toBe(true);
    expect(answer.instances.map((p) => p.subdomain)).toContain(instance.subdomain);

    const standard = { ...manifest, billing: { retentionYears: null } } as never;
    expect((await new BackupPlanService(prisma, standard).response()).retentionYears).toBe(8);
  });
});

describe('Sicherung jetzt, Liste, Prüfung', () => {
  it('stößt den Auftrag an, zeigt die Liste und vermerkt eine gelungene Prüfung', async () => {
    const { coolify, backups } = build();
    const { instance, backup, objectKey } = await withInstanceAndBackup(coolify);

    const list = await backups.list(instance.id, true);
    expect(list.backups).toHaveLength(1);
    expect(list.backups[0]).toMatchObject({ id: backup.id, objectKey, restorable: true, verified: false });
    expect(list.agent?.available).toBe(true);

    const { jobId } = await backups.trigger(instance.id, ACTOR, SOURCE);
    const sent = agent.jobBodies('backup').at(-1) as { instance: Record<string, unknown> };
    expect(sent.instance).toMatchObject({ subdomain: instance.subdomain, dbService: 'db', dbName: 'app' });
    const job = await backups.job(instance.id, jobId);
    expect(job).toMatchObject({ id: jobId, kind: 'backup' });

    const verify = await backups.verify(instance.id, backup.id, ACTOR, SOURCE);
    // Der Agent meldet beim Prüfauftrag den Schlüssel mit.
    agent.jobs.get(verify.jobId)!['result'] = { objectKey, sizeBytes: 12345, sha256: 'b'.repeat(64) };
    await backups.job(instance.id, verify.jobId, backup.id); // running
    await backups.job(instance.id, verify.jobId, backup.id); // succeeded
    const after = await prisma.backup.findUniqueOrThrow({ where: { id: backup.id } });
    expect(after.verifiedAt).not.toBeNull();
    const triggered = await prisma.auditLog.count({ where: { action: 'backup.job_triggered', objectId: { in: [instance.id, backup.id] } } });
    expect(triggered).toBe(2);
  });

  it('eine Prüfung mit FREMDEM Objektschlüssel vermerkt nichts', async () => {
    const { coolify, backups } = build();
    const { instance, backup } = await withInstanceAndBackup(coolify);
    const verify = await backups.verify(instance.id, backup.id, ACTOR, SOURCE);
    agent.jobs.get(verify.jobId)!['result'] = { objectKey: 'si/instances/anderer/x.dump.age' };
    await backups.job(instance.id, verify.jobId, backup.id);
    await backups.job(instance.id, verify.jobId, backup.id);
    const after = await prisma.backup.findUniqueOrThrow({ where: { id: backup.id } });
    expect(after.verifiedAt).toBeNull();
  });

  it('meldet einen nicht erreichbaren Agent mit 503 und ändert nichts', async () => {
    const { coolify } = build();
    const { instance } = await withInstanceAndBackup(coolify);
    const dead = new BackupAgentClient(
      new ConfigService({ BACKUP_AGENT_URL: 'http://127.0.0.1:9', BACKUP_AGENT_SECRET: AGENT_SECRET }),
    );
    const backups = new InstanceBackupService(prisma, audit, dead, manifest);
    const error = await backups.trigger(instance.id, ACTOR, SOURCE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackupAgentUnavailableError);
    // Die Liste bleibt lesbar, auch mit Agent-Teil.
    const list = await backups.list(instance.id, true);
    expect(list.agent).toEqual({ available: false, items: [] });
  });
});

describe('Wiederherstellung als NEUE Instanz', () => {
  it('legt eine neue Anwendung an, spielt per Agent ein und endet auf „ready" — ohne Schlüssel zu speichern', async () => {
    const { coolify, restores } = build();
    const { instance, backup, objectKey, company } = await withInstanceAndBackup(coolify);
    const input = dto(backup.id, instance.subdomain);
    const logs = captureLogs();
    let started!: RestoreView;
    try {
      started = await restores.start(instance.id, input, ACTOR, SOURCE);
      expect(started.status).toBe('provisioning');
      await waitUntil(
        async () => (await prisma.instanceRestore.findUniqueOrThrow({ where: { id: started.id } })).status === 'ready',
        'Wiederherstellung bereit',
      );
    } finally {
      logs.restore();
    }

    const row = await prisma.instanceRestore.findUniqueOrThrow({ where: { id: started.id } });
    expect(row).toMatchObject({ instanceId: instance.id, backupId: backup.id, newSubdomain: input.newSubdomain });
    expect(row.coolifyApplicationId).toMatch(/^attrappe-app-/);

    // Der Agent bekam genau den Auftrag mit Schlüssel, Objekt und Ziel-Stapel ...
    const job = agent.jobBodies('restore').at(-1) as Record<string, unknown>;
    expect(job).toMatchObject({
      objectKey,
      ageIdentity: AGE_IDENTITY,
      target: { subdomain: input.newSubdomain, composeProject: `proj-${row.coolifyApplicationId}`, dbName: 'app' },
    });
    // ... NUR NEUE Coolify-Anwendung, keine zweite Instanz-Zeile, alte unberührt.
    expect(coolify.calls.filter((c) => c === 'createApplication')).toHaveLength(1);
    expect(coolify.stopped).toHaveLength(0);
    expect(await prisma.instance.count({ where: { companyId: company.id } })).toBe(1);
    const untouched = await prisma.instance.findUniqueOrThrow({ where: { id: instance.id } });
    expect(untouched).toMatchObject({ subdomain: instance.subdomain, status: 'active', coolifyApplicationId: instance.coolifyApplicationId });
    // Die neue Anwendung bekam dieselben Geheimnisse wie die alte (Übernahme ohne Umschlüsseln).
    const env = coolify.environment.get(row.coolifyApplicationId as string) ?? {};
    expect(env['METRICS_TOKEN']).toBe(OLD_TOKENS.metrics);
    expect(env['SETUP_TOKEN']).toBe(OLD_TOKENS.setup);

    // Der private Schlüssel steht nirgends: Antwort, Zeile, Audit, Log.
    const audits = await prisma.auditLog.findMany({ where: { objectId: instance.id } });
    expect(audits.map((a) => a.action)).toContain('instance.restore_started');
    const everything = JSON.stringify({ started, row, audits, logs: logs.lines });
    expect(everything).not.toContain(AGE_IDENTITY);
    expect(everything).not.toContain(OLD_TOKENS.metrics);
    expect(row.message).not.toMatch(/AGE-SECRET/);
  });

  it('verlangt den eingetippten Instanznamen — sonst passiert NICHTS', async () => {
    const { coolify, restores } = build();
    const { instance, backup } = await withInstanceAndBackup(coolify);
    await expect(restores.start(instance.id, dto(backup.id, 'falscher-name'), ACTOR, SOURCE)).rejects.toBeInstanceOf(
      RestoreConfirmationError,
    );
    expect(await prisma.instanceRestore.count({ where: { instanceId: instance.id } })).toBe(0);
    expect(coolify.calls.filter((c) => c === 'createApplication')).toHaveLength(0);
  });

  it('lehnt eine vergebene oder ungültige neue Subdomain ab', async () => {
    const { coolify, restores } = build();
    const { instance, backup } = await withInstanceAndBackup(coolify);
    await expect(
      restores.start(instance.id, dto(backup.id, instance.subdomain, { newSubdomain: instance.subdomain }), ACTOR, SOURCE),
    ).rejects.toBeInstanceOf(SubdomainTakenError);
    await expect(
      restores.start(instance.id, dto(backup.id, instance.subdomain, { newSubdomain: 'www' }), ACTOR, SOURCE),
    ).rejects.toMatchObject({ errorCode: 'subdomain_invalid' });
    expect(await prisma.instanceRestore.count({ where: { instanceId: instance.id } })).toBe(0);
  });

  it('lässt keine zweite Wiederherstellung zugleich zu', async () => {
    const { coolify, restores } = build();
    const { instance, backup } = await withInstanceAndBackup(coolify);
    agent.runningPolls = 1_000_000;
    try {
      await restores.start(instance.id, dto(backup.id, instance.subdomain), ACTOR, SOURCE);
      await expect(
        restores.start(instance.id, dto(backup.id, instance.subdomain), ACTOR, SOURCE),
      ).rejects.toBeInstanceOf(RestoreInProgressError);
    } finally {
      agent.runningPolls = 1;
    }
  });

  it('meldet einen Fehlschlag des Agents sichtbar als „failed", ohne Schlüssel und ohne etwas zu löschen', async () => {
    const { coolify, restores } = build();
    const { instance, backup } = await withInstanceAndBackup(coolify);
    agent.finalStatus = 'failed';
    agent.finalMessage = `pg_restore: Fehler beim Entschlüsseln mit ${AGE_IDENTITY}`;
    let started!: RestoreView;
    try {
      started = await restores.start(instance.id, dto(backup.id, instance.subdomain), ACTOR, SOURCE);
      await waitUntil(
        async () => (await prisma.instanceRestore.findUniqueOrThrow({ where: { id: started.id } })).status === 'failed',
        'Wiederherstellung gescheitert',
      );
    } finally {
      agent.finalStatus = 'succeeded';
      agent.finalMessage = undefined;
    }
    const row = await prisma.instanceRestore.findUniqueOrThrow({ where: { id: started.id } });
    expect(row.message).toContain('Fehlgeschlagen');
    expect(row.message).toContain('Es wurde nichts gelöscht');
    expect(JSON.stringify(row)).not.toContain(AGE_IDENTITY);
    const errors = await prisma.auditLog.findMany({ where: { objectId: started.id } });
    expect(JSON.stringify(errors)).not.toContain(AGE_IDENTITY);
    // Eine gescheiterte Wiederherstellung ist nicht übernehmbar.
    await expect(restores.adopt(instance.id, started.id, ACTOR, SOURCE)).rejects.toBeInstanceOf(
      RestoreNotAdoptableError,
    );
  });

  it('endet bei nicht erreichbarem Agent auf „failed" mit klarem Text (kein stilles Scheitern)', async () => {
    const { coolify } = build();
    const { instance, backup } = await withInstanceAndBackup(coolify);
    const deadClient = new BackupAgentClient(
      new ConfigService({ BACKUP_AGENT_URL: 'http://127.0.0.1:9', BACKUP_AGENT_SECRET: AGENT_SECRET }),
    );
    const provisioner = new CoolifyProvisioner(coolify, async () => undefined);
    const noWait = async () => undefined;
    const provisioning = new InstanceProvisioningService(prisma, audit, coolifyConfig, provisioner, noWait, async () => true);
    const instances = new InstanceService(prisma, audit, crypto, coolifyConfig, provisioning, provisioner);
    const restores = new InstanceRestoreService(
      prisma, audit, coolifyConfig, provisioner, noWait, async () => true, crypto, instances, deadClient, manifest,
    );
    const started = await restores.start(instance.id, dto(backup.id, instance.subdomain), ACTOR, SOURCE);
    await waitUntil(
      async () => (await prisma.instanceRestore.findUniqueOrThrow({ where: { id: started.id } })).status === 'failed',
      'Wiederherstellung gescheitert (Agent fehlt)',
    );
    const row = await prisma.instanceRestore.findUniqueOrThrow({ where: { id: started.id } });
    expect(row.message).toContain('nicht erreichbar');
  });
});

describe('Übernahme', () => {
  async function readyRestore() {
    const ctx = build();
    const base = await withInstanceAndBackup(ctx.coolify);
    const started = await ctx.restores.start(base.instance.id, dto(base.backup.id, base.instance.subdomain), ACTOR, SOURCE);
    await waitUntil(
      async () => (await prisma.instanceRestore.findUniqueOrThrow({ where: { id: started.id } })).status === 'ready',
      'Wiederherstellung bereit',
    );
    const restore = await prisma.instanceRestore.findUniqueOrThrow({ where: { id: started.id } });
    return { ...ctx, ...base, restore };
  }

  it('stoppt die alte Instanz, stellt Subdomain und Anwendungs-ID atomar um und löscht NICHTS', async () => {
    const { coolify, restores, instance, old, restore, company } = await readyRestore();
    const instancesBefore = await prisma.instance.count();
    const backupsBefore = await prisma.backup.count({ where: { instanceId: instance.id } });

    const adopted = await restores.adopt(instance.id, restore.id, ACTOR, SOURCE);
    expect(adopted.status).toBe('adopted');
    expect(adopted.adoptedAt).not.toBeNull();

    // Alte Instanz GESTOPPT (nicht gelöscht):
    expect(coolify.stopped).toEqual([old.uuid]);
    expect(coolify.applicationsList.some((a) => a.uuid === old.uuid)).toBe(true);
    // Zeile umgestellt:
    const row = await prisma.instance.findUniqueOrThrow({ where: { id: instance.id } });
    expect(row).toMatchObject({
      subdomain: restore.newSubdomain,
      coolifyApplicationId: restore.coolifyApplicationId,
      coolifyDatabaseId: null,
      status: 'active',
    });
    // Nichts verschwunden:
    expect(await prisma.instance.count()).toBe(instancesBefore);
    expect(await prisma.backup.count({ where: { instanceId: instance.id } })).toBe(backupsBefore);
    expect(await prisma.company.count({ where: { id: company.id } })).toBe(1);
    // Audit mit ALTEN Werten, Verlauf der Organisation:
    const trail = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'instance.restore_adopted', objectId: instance.id },
    });
    expect(trail.beforeValue).toMatchObject({ subdomain: instance.subdomain, coolifyApplicationId: old.uuid });
    expect(trail.afterValue).toMatchObject({ subdomain: restore.newSubdomain });
    const notes = await prisma.note.findMany({ where: { companyId: company.id, bySystem: true } });
    expect(notes.some((n) => n.text.includes('gestoppt, NICHT gelöscht'))).toBe(true);
  });

  it('übernimmt bei zwei GLEICHZEITIGEN Aufrufen genau einmal', async () => {
    const { restores, instance, restore } = await readyRestore();
    const results = await Promise.allSettled([
      restores.adopt(instance.id, restore.id, ACTOR, SOURCE),
      restores.adopt(instance.id, restore.id, ACTOR, SOURCE),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(RestoreNotAdoptableError);
    const audits = await prisma.auditLog.count({ where: { action: 'instance.restore_adopted', objectId: instance.id } });
    expect(audits).toBe(1);
  });

  it('stellt NICHTS um, wenn die alte Instanz sich nicht stoppen lässt', async () => {
    const { coolify, restores, instance, restore } = await readyRestore();
    coolify.failsAt = 'stopApplication';
    await expect(restores.adopt(instance.id, restore.id, ACTOR, SOURCE)).rejects.toBeInstanceOf(AdoptStopFailedError);
    coolify.failsAt = null;
    const row = await prisma.instance.findUniqueOrThrow({ where: { id: instance.id } });
    expect(row.subdomain).toBe(instance.subdomain);
    const still = await prisma.instanceRestore.findUniqueOrThrow({ where: { id: restore.id } });
    expect(still.status).toBe('ready');
  });

  it('übernimmt keine fremde oder nicht bereite Wiederherstellung', async () => {
    const { restores, instance, restore } = await readyRestore();
    await prisma.instanceRestore.update({ where: { id: restore.id }, data: { status: 'restoring' } });
    await expect(restores.adopt(instance.id, restore.id, ACTOR, SOURCE)).rejects.toBeInstanceOf(RestoreNotAdoptableError);
    await expect(restores.adopt(randomUUID(), restore.id, ACTOR, SOURCE)).rejects.toMatchObject({
      errorCode: 'restore_not_found',
    });
  });
});
