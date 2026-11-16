import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { FakeBackupAgent } from '../test-support/fake-backup-agent';
import { captureLogs } from '../test-support/log-capture';
import { BackupAgentClient, scrub } from './backup-agent.client';
import {
  BackupAgentNotConfiguredError,
  BackupAgentRejectedError,
  BackupAgentUnavailableError,
} from './backup-agent.errors';

const SECRET = 'agent-secret-0123456789abcdef0123456789abcdef';
const AGE_KEY = 'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ';

function clientFor(url: string, secret: string | null = SECRET): BackupAgentClient {
  return new BackupAgentClient(
    new ConfigService({ BACKUP_AGENT_URL: url, BACKUP_AGENT_SECRET: secret ?? undefined }),
  );
}

describe('BackupAgentClient gegen eine Attrappe des Agents (node:http)', () => {
  let agent: FakeBackupAgent;
  let url: string;

  beforeEach(async () => {
    agent = new FakeBackupAgent(SECRET);
    url = await agent.start();
  });
  afterEach(async () => {
    await agent.stop();
  });

  it('signiert jede Anfrage so, dass der Agent sie annimmt', async () => {
    const client = clientFor(url);
    expect((await client.health()).status).toBe('ok');
    await client.getTarget();
    await client.testTarget();
    await client.listBackups({ kind: 'instance', subdomain: 'muster' });
    expect(agent.rejected).toBe(0);
    expect(agent.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /v1/health',
      'GET /v1/target',
      'POST /v1/target/test',
      'GET /v1/backups?kind=instance&subdomain=muster',
    ]);
  });

  it('verwendet für jede Anfrage eine neue Nonce', async () => {
    const client = clientFor(url);
    await client.health();
    await client.health();
    const nonces = agent.requests.map((r) => r.headers['x-si-nonce']);
    expect(new Set(nonces).size).toBe(2);
  });

  it('wird mit falschem Geheimnis abgewiesen (Agent: 401 -> 502 rejected)', async () => {
    const client = clientFor(url, 'ein-anderes-geheimnis-0123456789abcdef0123');
    await expect(client.health()).rejects.toBeInstanceOf(BackupAgentRejectedError);
    expect(agent.rejected).toBe(1);
  });

  it('schickt Auftrag und Kennung; der restore-Auftrag trägt den Schlüssel nur im Body', async () => {
    const client = clientFor(url);
    const { jobId } = await client.startJob({
      kind: 'restore',
      objectKey: 'p/instances/x/2026-01-01T000000Z.dump.age',
      sha256: 'c'.repeat(64),
      ageIdentity: AGE_KEY,
      target: { subdomain: 'x2', composeProject: 'x2', dbService: 'db', dbName: 'a', dbUser: 'a' },
    });
    expect(jobId).toMatch(/^job-/);
    const job = await client.getJob(jobId);
    expect(job.kind).toBe('restore');
    // Nur der POST trug den Schlüssel, nirgends Pfad oder Kopfzeilen.
    for (const request of agent.requests) {
      const carriesKey = request.body.includes(AGE_KEY);
      expect(carriesKey).toBe(request.method === 'POST' && request.path === '/v1/jobs');
      expect(request.path + JSON.stringify(request.headers)).not.toContain(AGE_KEY);
    }
  });

  it('meldet einen nicht erreichbaren Agent als 503 mit klarem Code (kein stilles Scheitern)', async () => {
    await agent.stop();
    const client = clientFor(url);
    const error = await client.health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackupAgentUnavailableError);
    expect((error as BackupAgentUnavailableError).getStatus()).toBe(503);
    expect((error as BackupAgentUnavailableError).errorCode).toBe('backup_agent_unavailable');
  });

  it('meldet fehlendes Geheimnis als 503 backup_agent_not_configured', async () => {
    const error = await clientFor(url, null).health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackupAgentNotConfiguredError);
    expect((error as BackupAgentNotConfiguredError).getStatus()).toBe(503);
    expect(clientFor(url, 'kurz').isConfigured()).toBe(false);
  });

  it('reicht Fehlertexte des Agents gesäubert weiter (kein age-Schlüssel, höchstens 300 Zeichen)', async () => {
    agent.failWith = 500;
    const client = clientFor(url);
    const error = await client.testTarget().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackupAgentRejectedError);
    expect(JSON.stringify((error as BackupAgentRejectedError).getResponse())).not.toContain('Signatur');
    expect(scrub(`Fehler ${AGE_KEY} Ende`)).toBe('Fehler [entfernt] Ende');
    expect(scrub('abc geheimnis-wert-123 xyz', ['geheimnis-wert-123'])).toBe('abc [entfernt] xyz');
  });

  it('PROTOKOLLIERT KEINE GEHEIMNISSE: weder Body noch Schlüssel noch HMAC-Geheimnis', async () => {
    const logs = captureLogs();
    try {
      const client = clientFor(url);
      await client.putTarget({
        type: 's3',
        schedule: 'daily',
        retentionDays: 30,
        objectLock: false,
        s3: {
          endpoint: 'https://s3.example.com',
          region: 'eu',
          bucket: 'bucket',
          prefix: 'p',
          pathStyle: true,
          accessKeyId: 'ZUGANGSKENNUNG-GEHEIM',
          secretAccessKey: 'GEHEIMER-SCHLUESSEL-WERT',
        },
      });
      await client.startJob({
        kind: 'restore',
        objectKey: 'k',
        sha256: 'c'.repeat(64),
        ageIdentity: AGE_KEY,
        target: { subdomain: 'x', composeProject: 'x', dbService: 'db', dbName: 'a', dbUser: 'a' },
      });
      agent.failWith = 500;
      await client.testTarget().catch(() => undefined);
      await agent.stop();
      await client.health().catch(() => undefined);
    } finally {
      logs.restore();
    }
    const everything = logs.lines.join('\n');
    expect(logs.lines.length).toBeGreaterThan(0);
    for (const secret of ['ZUGANGSKENNUNG-GEHEIM', 'GEHEIMER-SCHLUESSEL-WERT', AGE_KEY, SECRET]) {
      expect(everything).not.toContain(secret);
    }
  });
});

describe('BackupAgentClient: nur erlaubte Methoden (R1/R4)', () => {
  const ALLOWED_PUBLIC = [
    'getJob',
    'getTarget',
    'health',
    'isConfigured',
    'listBackups',
    'putTarget',
    'startJob',
    'testTarget',
  ].sort();

  it('hat genau die aufgezählten öffentlichen Methoden — nichts, das entfernt', () => {
    const names = Object.getOwnPropertyNames(BackupAgentClient.prototype)
      .filter((n) => n !== 'constructor' && !['secret', 'baseUrl', 'timeoutMs', 'call'].includes(n))
      .sort();
    expect(names).toEqual(ALLOWED_PUBLIC);
  });

  it('kennt im Quelltext nur die HTTP-Methoden GET, PUT und POST', () => {
    const source = readFileSync(join(__dirname, 'backup-agent.client.ts'), 'utf8');
    expect(source).toContain("export type AgentMethod = 'GET' | 'PUT' | 'POST';");
    const calls = [...source.matchAll(/this\.call(?:<[^>]*>)?\(\s*'([A-Z]+)'/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThanOrEqual(7);
    expect(calls.every((m) => ['GET', 'PUT', 'POST'].includes(m))).toBe(true);
    expect(source).not.toMatch(/['"`]DELETE['"`]/i);
  });
});
