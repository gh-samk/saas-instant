import { randomUUID } from 'crypto';
import { datePlusDays, today, toDate } from '@saas-instant/shared';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { CoolifyConfigService } from '../coolify/coolify.config';
import { CryptoService } from '../crypto/crypto.service';
import { CoolifyProvisioner } from '../coolify/coolify.provisioner';
import { CoolifyMock } from '../test-support/coolify-mock';
import {
  createCompany,
  newPrefix,
  prisma,
  cleanUp,
  disconnect,
} from '../test-support/company-provisioning';
import { InstanceProvisioningService } from './instance-provisioning.service';
import { InstanceService } from './instance.service';

/**
 * Die Übersicht „Instanzen" (gewünscht am 12.09.2026).
 *
 * Eigene Datei, nicht in `instance.integration.spec.ts`: Die Liste liest nur,
 * sie braucht keinen Aufbau und keine Coolify-Attrappe mit Verhalten.
 */
jest.setTimeout(60_000);

const PREFIX = newPrefix('instanz-liste');

function build(): InstanceService {
  const audit = new AuditService(prisma);
  const crypto = new CryptoService({
    get: () => 'test-schluessel-mindestens-32-zeichen-lang-x',
  } as never);
  const coolifyConfig = new CoolifyConfigService(
    new ConfigService({
      COOLIFY_TOKEN: 'attrappe-token-mindestens-32-zeichen-lang',
      CONTROL_INSTANCE_BASE_DOMAIN: 'example.com',
    }),
  );
  const coolify = new CoolifyMock();
  const provisioning = new InstanceProvisioningService(
    prisma,
    audit,
    coolifyConfig,
    new CoolifyProvisioner(coolify, async () => undefined),
    async () => undefined,
    async () => true,
  );
  return new InstanceService(prisma, audit, crypto, coolifyConfig, provisioning, new CoolifyProvisioner(coolify, async () => undefined));
}

afterAll(async () => {
  await cleanUp(PREFIX);
  await disconnect();
});

describe('Die Übersicht aller Instanzen', () => {
  it('liefert Subdomain, Adresse, Status und Organisation — sortiert nach Subdomain', async () => {
    const identifier = randomUUID().slice(0, 6);
    const a = await createCompany(PREFIX);
    const b = await createCompany(PREFIX);
    await prisma.instance.create({
      data: { companyId: a.id, subdomain: `zz-liste-${identifier}`, status: 'active' },
    });
    await prisma.instance.create({
      data: { companyId: b.id, subdomain: `aa-liste-${identifier}`, status: 'provisioning' },
    });

    const own = (await build().all()).filter((e) => e.subdomain.endsWith(identifier));

    expect(own.map((e) => e.subdomain)).toEqual([
      `aa-liste-${identifier}`,
      `zz-liste-${identifier}`,
    ]);
    expect(own[0]).toMatchObject({
      status: 'provisioning',
      url: `https://aa-liste-${identifier}.example.com`,
      company: { id: b.id, name: b.name },
    });
    expect(own[1]!.company.id).toBe(a.id);
  });

  it('gibt keine Geheimnisse heraus', async () => {
    const identifier = randomUUID().slice(0, 6);
    const org = await createCompany(PREFIX);
    await prisma.instance.create({
      data: {
        companyId: org.id,
        subdomain: `geheim-liste-${identifier}`,
        status: 'active',
        metricsTokenEncrypted: 'verschluesselt-kennzahlen',
        setupTokenEncrypted: 'verschluesselt-setup',
      },
    });
    const entry = (await build().all()).find((e) => e.subdomain.endsWith(identifier));
    // Erlaubnisliste statt Verbotsliste: genau diese Felder, keins mehr.
    expect(Object.keys(entry!).sort()).toEqual(
      [
        'activePersons',
        'appVersion',
        'backupMissing',
        'company',
        'createdAt',
        'id',
        'lastBackupAt',
        'status',
        'subdomain',
        'url',
      ].sort(),
    );
  });

  it('liefert Version, aktive Personen und Sicherungslage — mit der Frist der Aufgabe', async () => {
    const identifier = randomUUID().slice(0, 6);
    const fresh = await createCompany(PREFIX);
    const overdue = await createCompany(PREFIX);
    const never = await createCompany(PREFIX);
    const stopped = await createCompany(PREFIX);
    const mk = (companyId: string, name: string, status: 'active' | 'stopped') =>
      prisma.instance.create({
        data: { companyId, subdomain: `${name}-${identifier}`, status, appVersion: '1.4.2' },
      });
    const a = await mk(fresh.id, 'frisch', 'active');
    const b = await mk(overdue.id, 'alt', 'active');
    await mk(never.id, 'nie', 'active');
    const d = await mk(stopped.id, 'aus', 'stopped');
    const day = (back: number) => toDate(datePlusDays(today(), -back));
    // Frist: BACKUP_MISSING_AFTER_DAYS (2) — gestern ist in Ordnung, vor drei Tagen nicht.
    await prisma.backup.create({ data: { instanceId: a.id, date: day(1), sizeBytes: 10n } });
    await prisma.backup.create({ data: { instanceId: b.id, date: day(3), sizeBytes: 10n } });
    await prisma.backup.create({ data: { instanceId: b.id, date: day(9), sizeBytes: 10n } });
    // Zwei Abfragen: die jüngere erfolgreiche zählt, die gescheiterte nicht.
    await prisma.metric.create({
      data: { instanceId: a.id, date: day(5), activePersons: 3, fetchSuccessful: true },
    });
    await prisma.metric.create({
      data: { instanceId: a.id, date: day(1), activePersons: 7, fetchSuccessful: true },
    });
    await prisma.metric.create({
      data: { instanceId: a.id, date: day(0), activePersons: null, fetchSuccessful: false },
    });
    await prisma.metric.create({
      data: { instanceId: d.id, date: day(1), activePersons: 5, fetchSuccessful: true },
    });

    const own = (await build().all()).filter((e) => e.subdomain.endsWith(identifier));
    const by = Object.fromEntries(own.map((e) => [e.subdomain.split('-')[0], e]));

    expect(by['frisch']).toMatchObject({
      appVersion: '1.4.2',
      activePersons: 7,
      lastBackupAt: datePlusDays(today(), -1),
      backupMissing: false,
    });
    expect(by['alt']).toMatchObject({
      activePersons: null,
      lastBackupAt: datePlusDays(today(), -3),
      backupMissing: true,
    });
    expect(by['nie']).toMatchObject({ lastBackupAt: null, backupMissing: true });
    // Nicht laufend: weder Personen noch Alarm.
    expect(by['aus']).toMatchObject({ activePersons: null, backupMissing: false });
  });
});
