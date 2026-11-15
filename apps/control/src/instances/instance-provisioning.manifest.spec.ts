import type { ConfigService } from '@nestjs/config';
import { CoolifyConfigService } from '../coolify/coolify.config';
import { CoolifyProvisioner } from '../coolify/coolify.provisioner';
import { checkProvisioning } from '../manifest/sections/provisioning';
import type { ManifestService } from '../manifest/manifest.service';
import { CoolifyMock } from '../test-support/coolify-mock';
import { InstanceProvisioningService } from './instance-provisioning.service';

/**
 * Das Manifest STEUERT die Anlage: Hostmuster, Umgebungsvorlagen, Compose-Quelle
 * und Health-Pfad kommen bei Coolify und beim Health-Check tatsächlich an.
 */
function setup(provisioning: Record<string, unknown>) {
  const errors: string[] = [];
  const section = checkProvisioning(provisioning, errors);
  expect(errors).toEqual([]);
  const values: Record<string, string> = {
    CONTROL_COOLIFY_TOKEN: 't',
    CONTROL_COOLIFY_PROJECT_UUID: 'p',
    CONTROL_COOLIFY_SERVER_UUID: 's',
    CONTROL_COOLIFY_DEPLOY_KEY_UUID: 'k',
    CONTROL_INSTANCE_SMTP_HOST: 'mail.example.com',
    CONTROL_INSTANCE_SMTP_FROM: 'a@example.com',
  };
  const config = new CoolifyConfigService(
    { get: (n: string) => values[n] } as unknown as ConfigService,
    { provisioning: section } as unknown as ManifestService,
  );
  const coolify = new CoolifyMock();
  const updates: unknown[] = [];
  const prisma = {
    instance: {
      update: jest.fn(async (a: unknown) => void updates.push(a)),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const health = jest.fn().mockResolvedValue(true);
  const service = new InstanceProvisioningService(
    prisma as never,
    audit as never,
    config,
    new CoolifyProvisioner(coolify, async () => undefined),
    async () => undefined,
    health,
  );
  return { service, coolify, health, config, updates };
}

describe('Manifest-gesteuerte Anlage einer Instanz', () => {
  const MANIFEST = {
    instanceDomainBase: 'kunden.example.com',
    subdomainPattern: 'app-{slug}.{base}',
    instancePrefix: 'crm',
    healthPath: '/gesund',
    instanceEnv: { TENANT: '{subdomain}', OPEN: '{setupToken}', READ: '{metricsToken}', HOST: '{domain}' },
  };

  it('nimmt Hostmuster, Namenspräfix und Umgebungsvorlagen aus dem Manifest', async () => {
    const { service, coolify, updates } = setup(MANIFEST);

    await service.executeFrom('i1', 'muster', { metricsToken: 'mt', setupToken: 'st' });

    const app = coolify.applicationsList[0];
    expect(app.name).toBe('crm-muster');
    expect(app.domains).toEqual(['app-muster.kunden.example.com']);
    const env = coolify.environment.get(app.uuid) ?? {};
    expect(env).toMatchObject({
      APP_URL: 'https://app-muster.kunden.example.com',
      TENANT: 'muster',
      OPEN: 'st',
      READ: 'mt',
      HOST: 'app-muster.kunden.example.com',
      SETUP_TOKEN: 'st',
      METRICS_TOKEN: 'mt',
    });
    expect(updates).toContainEqual({ where: { id: 'i1' }, data: { coolifyApplicationId: app.uuid } });
  });

  it('prüft die Gesundheit am deklarierten Pfad des richtigen Hosts', async () => {
    const { service, health } = setup(MANIFEST);
    await service.executeFrom('i1', 'muster', { metricsToken: 'mt', setupToken: 'st' });
    expect(health).toHaveBeenCalledWith('app-muster.kunden.example.com', '/gesund');
  });

  it('gibt dem Anbieter die Compose-Quelle aus dem Manifest (Git-URL)', () => {
    const { config } = setup({ composeSource: 'git@git.example.com:x/compose.git' });
    expect(config.read()?.repository).toBe('git@git.example.com:x/compose.git');
  });

  it('meldet das Scheitern des Anbieters im Klartext an die Karte', async () => {
    const { service, coolify, updates } = setup(MANIFEST);
    coolify.deployments.set('attrappe-deploy-attrappe-app-1', 'failed');
    await service.executeFrom('i1', 'muster', { metricsToken: 'mt', setupToken: 'st' });
    const last = updates[updates.length - 1] as { data: { message: string } };
    expect(last.data.message).toContain('Fehlgeschlagen: Das erste Deployment endete mit „failed"');
  });
});
