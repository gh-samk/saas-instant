import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { CoolifyConfigService } from '../coolify/coolify.config';
import { CryptoService } from '../crypto/crypto.service';
import { CoolifyProvisioner } from '../coolify/coolify.provisioner';
import { MOCK_COMMIT, CoolifyMock } from '../test-support/coolify-mock';
import {
  createCompany,
  newPrefix,
  prisma,
  cleanUp,
  disconnect,
  waitUntil,
} from '../test-support/company-provisioning';
import { InstanceProvisioningService } from './instance-provisioning.service';
import { InstanceService } from './instance.service';

/**
 * Die Versionsangabe einer NEU ANGELEGTEN Instanz (12.09.2026).
 *
 * Vorher meldete jede neue Instanz unter `/api/version` „dev": Coolify legt
 * `SOURCE_COMMIT` beim Lesen der Compose-Datei leer an und trägt dann seinen
 * eigenen Wert nicht mehr ein. Der Aufbau setzt sie deshalb selbst — auf den
 * Commit, den das erste Ausrollen ausgecheckt hat, VOR dem zweiten.
 *
 * Eigene Datei, nicht in `instance.integration.spec.ts`.
 */
jest.setTimeout(60_000);

const PREFIX = newPrefix('instanz-quellstand');
const SOURCE = { ip: '203.0.113.9', userAgent: 'Jest-Integration' };
const ACTOR = { userId: null, name: 'sam' };

const audit = new AuditService(prisma);
const crypto = new CryptoService({
  get: () => 'test-schluessel-mindestens-32-zeichen-lang-x',
} as never);
const coolifyConfig = new CoolifyConfigService(
  new ConfigService({
    COOLIFY_TOKEN: 'attrappe-token-mindestens-32-zeichen-lang',
    CONTROL_INSTANCE_BASE_DOMAIN: 'example.com',
    CONTROL_INSTANCE_SMTP_HOST: 'mail.example.com',
    CONTROL_INSTANCE_SMTP_USER: 'noreply@example.com',
    CONTROL_INSTANCE_SMTP_PASS: 'attrappe-passwort',
    CONTROL_INSTANCE_SMTP_FROM: 'Mein Produkt <noreply@example.com>',
  }),
);

async function createWith(subdomain: string, commit: string | null) {
  const coolify = new CoolifyMock();
  coolify.commit = commit;
  const provisioning = new InstanceProvisioningService(
    prisma,
    audit,
    coolifyConfig,
    new CoolifyProvisioner(coolify, async () => undefined),
    async () => undefined,
    async () => true,
  );
  const service = new InstanceService(prisma, audit, crypto, coolifyConfig, provisioning, new CoolifyProvisioner(coolify, async () => undefined));
  const company = await createCompany(PREFIX);
  await service.createPreview(company.id, subdomain, ACTOR, SOURCE);
  await service.create(company.id, subdomain, ACTOR, SOURCE);

  const end = async () =>
    prisma.instance.findUniqueOrThrow({ where: { companyId: company.id } });
  await waitUntil(async () => {
    const i = await end();
    return i.status === 'active' || i.message?.startsWith('Fehlgeschlagen') === true;
  }, 'der Aufbau ist durch');
  const instance = await end();
  return { coolify, instance, environment: coolify.environment.get(instance.coolifyApplicationId!) ?? {} };
}

beforeAll(async () => {
  await cleanUp('instanz-quellstand');
});

afterAll(async () => {
  await cleanUp(PREFIX);
  await disconnect();
});

describe('SOURCE_COMMIT einer neu angelegten Instanz', () => {
  it('ist der Commit des ersten Ausrollens — gesetzt VOR dem zweiten', async () => {
    const { coolify, instance, environment } = await createWith('quellstand-mit', MOCK_COMMIT);

    expect(instance.status).toBe('active');
    expect(environment['SOURCE_COMMIT']).toBe(MOCK_COMMIT);

    // Erst ausrollen (Coolify klont und nennt den Commit), dann setzen, dann
    // das zweite Ausrollen — nur das startet die Container mit dem Wert.
    const first = coolify.calls.indexOf('startDeploy');
    const set = coolify.calls.lastIndexOf('setEnvironmentVariable');
    const second = coolify.calls.lastIndexOf('startDeploy');
    expect(first).toBeLessThan(set);
    expect(set).toBeLessThan(second);
  });

  it('lässt den Aufbau heil, wenn Coolify keinen Commit nennt — nur die Anzeige fehlt', async () => {
    const { instance, environment } = await createWith('quellstand-ohne', null);

    expect(instance.status).toBe('active');
    expect(environment['SOURCE_COMMIT']).toBeUndefined();
  });
});
