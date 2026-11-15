import { ProvisioningFailedError } from '../provisioning/provisioner';
import { CoolifyMock } from '../test-support/coolify-mock';
import { CoolifyProvisioner } from './coolify.provisioner';

const NO_WAIT = async () => undefined;
const REQUEST = {
  name: 'instance-muster',
  host: 'app-muster.example.com',
  environment: { APP_URL: 'https://app-muster.example.com', SETUP_TOKEN: 'a', METRICS_TOKEN: 'b', EXTRA: 'c' },
};

describe('CoolifyProvisioner — create', () => {
  it('legt an, setzt JEDE Umgebungsvariable und die Domäne des Requests, rollt zweimal aus', async () => {
    const coolify = new CoolifyMock();
    const provisioner = new CoolifyProvisioner(coolify, NO_WAIT);
    const created: string[] = [];
    const progress: string[] = [];

    const result = await provisioner.create(REQUEST, {
      onCreated: (ref) => void created.push(ref),
      onProgress: (text) => void progress.push(text),
    });

    expect(created).toEqual([result.ref]);
    expect(coolify.applicationsList[0]).toMatchObject({
      name: 'instance-muster',
      domains: ['app-muster.example.com'],
    });
    expect(coolify.environment.get(result.ref)).toMatchObject(REQUEST.environment);
    // Reihenfolge: anlegen, Umgebung, 1. Ausrollen, Domäne, 2. Ausrollen.
    const calls = coolify.calls.filter((c) => c !== 'getDeployment');
    expect(calls[0]).toBe('createApplication');
    expect(calls.slice(1, 5)).toEqual(Array(4).fill('setEnvironmentVariable'));
    expect(calls[5]).toBe('startDeploy');
    expect(calls.filter((c) => c === 'startDeploy')).toHaveLength(2);
    expect(calls.indexOf('setDomain')).toBeGreaterThan(calls.indexOf('startDeploy'));
    expect(progress.length).toBeGreaterThanOrEqual(4);
    expect(result.commit).not.toBeNull();
  });

  it('meldet ein gescheitertes Deployment als ProvisioningFailedError mit Klartext', async () => {
    const coolify = new CoolifyMock();
    coolify.deployments.set('attrappe-deploy-attrappe-app-1', 'failed');
    const provisioner = new CoolifyProvisioner(coolify, NO_WAIT);

    const error = await provisioner.create(REQUEST).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProvisioningFailedError);
    expect((error as Error).message).toContain('Fehlgeschlagen: Das erste Deployment endete mit „failed"');
    expect((error as Error).message).toContain('instance-muster');
  });

  it('wirft einen fremden Fehler unverändert (kein Klartext vorgetäuscht)', async () => {
    const coolify = new CoolifyMock();
    coolify.failsAt = 'createApplication';
    await expect(new CoolifyProvisioner(coolify, NO_WAIT).create(REQUEST)).rejects.not.toBeInstanceOf(
      ProvisioningFailedError,
    );
  });
});

describe('CoolifyProvisioner — status und stop', () => {
  it('listet, liest eine einzelne und kennt Unbekanntes als null', async () => {
    const coolify = new CoolifyMock();
    const app = coolify.setUp('instance-a', 'a.example.com', 'running');
    const provisioner = new CoolifyProvisioner(coolify, NO_WAIT);

    expect(await provisioner.status()).toEqual([
      { ref: app.uuid, name: 'instance-a', domains: ['a.example.com'], status: 'running' },
    ]);
    expect(await provisioner.status(app.uuid)).toMatchObject({ ref: app.uuid });
    expect(await provisioner.status('weg')).toBeNull();
  });

  it('stoppt — und mehr gibt es nicht', async () => {
    const coolify = new CoolifyMock();
    const app = coolify.setUp('instance-a', 'a.example.com', 'running');
    await new CoolifyProvisioner(coolify, NO_WAIT).stop(app.uuid);
    expect(coolify.stopped).toEqual([app.uuid]);
  });
});
