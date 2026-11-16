import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { sanitizeForAudit } from '../audit/audit.service';
import { FakeBackupAgent } from '../test-support/fake-backup-agent';
import { captureLogs } from '../test-support/log-capture';
import { BackupAgentClient } from './backup-agent.client';
import { BackupAgentUnavailableError } from './backup-agent.errors';
import { BackupSettingsService, BackupSettingsInvalidError } from './backup-settings.service';
import { BackupSettingsUpdateDto } from './dto/backup-settings.dto';

const SECRET = 'agent-secret-0123456789abcdef0123456789abcdef';
const USER = { id: 'u1', username: 'sam' };
const SOURCE = { ip: '203.0.113.1', userAgent: 'jest' };
const AGE_IDENTITY = 'AGE-SECRET-KEY-1ABCDEFGHJKLMNPQRSTUVWXYZ0123456789ABCDEFGHJKLMNPQRSTUV';
const SECRETS = ['ZUGANG-KENNUNG-123', 'GEHEIMER-S3-SCHLUESSEL-456', 'PRIVATER-SSH-SCHLUESSEL-789', 'SFTP-PASSWORT-000'];

function s3Body(): Record<string, unknown> {
  return {
    type: 's3',
    schedule: 'daily',
    retentionDays: 30,
    objectLock: true,
    s3: {
      endpoint: 'https://s3.example.com',
      region: 'eu-central-1',
      bucket: 'meine-sicherung',
      prefix: 'si',
      pathStyle: false,
      accessKeyId: SECRETS[0],
      secretAccessKey: SECRETS[1],
    },
  };
}

function dtoOf(raw: Record<string, unknown>): BackupSettingsUpdateDto {
  return plainToInstance(BackupSettingsUpdateDto, raw);
}

/** Minimale Datenbankattrappe: ein Singleton, wie die echte Tabelle. */
function fakePrisma() {
  const state: { row: Record<string, unknown> | null } = { row: null };
  return {
    state,
    backupTarget: {
      findUnique: jest.fn(async () => state.row),
      upsert: jest.fn(async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        state.row = state.row === null ? { ...args.create, lastTestAt: null, lastTestOk: null, lastTestMessage: null } : { ...state.row, ...args.update };
        return state.row;
      }),
      updateMany: jest.fn(async (args: { data: Record<string, unknown> }) => {
        if (state.row !== null) state.row = { ...state.row, ...args.data };
        return { count: state.row === null ? 0 : 1 };
      }),
    },
  };
}

describe('BackupSettingsService', () => {
  let agent: FakeBackupAgent;
  let service: BackupSettingsService;
  let prisma: ReturnType<typeof fakePrisma>;
  let audit: { log: jest.Mock };

  beforeEach(async () => {
    agent = new FakeBackupAgent(SECRET);
    const url = await agent.start();
    prisma = fakePrisma();
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    const client = new BackupAgentClient(
      new ConfigService({ BACKUP_AGENT_URL: url, BACKUP_AGENT_SECRET: SECRET }),
    );
    service = new BackupSettingsService(prisma as never, audit as never, client);
  });
  afterEach(async () => {
    await agent.stop();
  });

  it('reicht Geheimnisse an den Agent durch, speichert und liefert aber nur Metadaten', async () => {
    const logs = captureLogs();
    let response;
    try {
      response = await service.update(dtoOf(s3Body()), USER, SOURCE);
    } finally {
      logs.restore();
    }
    // Der Agent hat die Zugangsdaten bekommen ...
    const sent = agent.requests.find((r) => r.method === 'PUT' && r.path === '/v1/target');
    expect(sent?.body).toContain(SECRETS[0]);
    expect(sent?.body).toContain(SECRETS[1]);
    // ... die Verwaltung nirgends sonst: Antwort, Zeile, Audit, Log.
    const everything = JSON.stringify({
      response,
      row: prisma.state.row,
      upserts: prisma.backupTarget.upsert.mock.calls,
      audit: audit.log.mock.calls,
      sanitizedAudit: audit.log.mock.calls.map((c) => sanitizeForAudit(c[0])),
      logs: logs.lines,
    });
    for (const secret of SECRETS) expect(everything).not.toContain(secret);

    expect(response.target).toMatchObject({
      type: 's3',
      endpoint: 'https://s3.example.com',
      bucket: 'meine-sicherung',
      region: 'eu-central-1',
      path: 'si',
      schedule: 'daily',
      retentionDays: 30,
      lastTestOk: null,
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'backup.target_updated',
        afterValue: expect.objectContaining({ bucket: 'meine-sicherung', objectLock: true }),
      }),
    );
  });

  it('liefert den privaten age-Schlüssel GENAU EINMAL (Ersteinrichtung) und speichert ihn nie', async () => {
    agent.putTargetReply = { ok: true, ageRecipient: 'age1empfaenger', ageIdentity: AGE_IDENTITY };
    const logs = captureLogs();
    let first;
    let later;
    try {
      first = await service.update(dtoOf(s3Body()), USER, SOURCE);
      agent.putTargetReply = { ok: true, ageRecipient: 'age1empfaenger' };
      later = await service.update(dtoOf(s3Body()), USER, SOURCE);
    } finally {
      logs.restore();
    }
    expect(first.ageIdentity).toBe(AGE_IDENTITY);
    expect(later.ageIdentity).toBeUndefined();
    const get = await service.get();
    expect(get.ageIdentity).toBeUndefined();
    const persisted = JSON.stringify({
      row: prisma.state.row,
      audit: audit.log.mock.calls,
      logs: logs.lines,
      get,
      later,
    });
    expect(persisted).not.toContain(AGE_IDENTITY);
    expect(audit.log.mock.calls[0][0].afterValue.firstSetup).toBe(true);
    expect(audit.log.mock.calls[1][0].afterValue.firstSetup).toBe(false);
  });

  it('GET liefert Metadaten und Agent-Zustand, nie Zugangsdaten', async () => {
    await service.update(dtoOf(s3Body()), USER, SOURCE);
    const result = await service.get();
    expect(result.agent).toMatchObject({ configured: true, reachable: true, targetConfigured: true });
    expect(result.agent.ageRecipient).toBe('age1testempfaenger');
    for (const secret of SECRETS) expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('GET bleibt lesbar, wenn der Agent fehlt', async () => {
    await agent.stop();
    const result = await service.get();
    expect(result.agent).toMatchObject({ configured: true, reachable: false });
  });

  it('PUT bei nicht erreichbarem Agent: 503 und NICHTS gespeichert', async () => {
    await agent.stop();
    await expect(service.update(dtoOf(s3Body()), USER, SOURCE)).rejects.toBeInstanceOf(
      BackupAgentUnavailableError,
    );
    expect(prisma.state.row).toBeNull();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('Verbindungstest speichert Ergebnis (gekürzt, ohne Schlüssel) und audit-protokolliert ihn', async () => {
    await service.update(dtoOf(s3Body()), USER, SOURCE);
    agent.testReply = { ok: false, message: `Zugriff verweigert ${AGE_IDENTITY} ${'x'.repeat(500)}` };
    const result = await service.test(USER, SOURCE);
    expect(result.ok).toBe(false);
    expect(result.message.length).toBeLessThanOrEqual(300);
    expect(result.message).not.toContain(AGE_IDENTITY);
    expect(prisma.state.row).toMatchObject({ lastTestOk: false });
    expect(audit.log).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'backup.target_tested', afterValue: expect.objectContaining({ ok: false }) }),
    );
  });

  it('Verbindungstest bei fehlendem Agent: vermerkt den Fehlschlag UND wirft 503', async () => {
    await service.update(dtoOf(s3Body()), USER, SOURCE);
    await agent.stop();
    await expect(service.test(USER, SOURCE)).rejects.toBeInstanceOf(BackupAgentUnavailableError);
    expect(prisma.state.row).toMatchObject({ lastTestOk: false });
  });

  it('lehnt Storage Box ohne passende Anmeldeart-Daten ab, bevor der Agent etwas sieht', async () => {
    const body = {
      type: 'storagebox',
      schedule: 'twice_daily',
      retentionDays: 14,
      objectLock: false,
      storagebox: { host: 'u1.your-storagebox.de', port: 23, username: 'u1', path: '/backups', authType: 'key' },
    };
    await expect(service.update(dtoOf(body), USER, SOURCE)).rejects.toBeInstanceOf(BackupSettingsInvalidError);
    expect(agent.requests).toHaveLength(0);
  });

  it('Storage Box mit Schlüssel: nur der gewählte Zugang geht an den Agent', async () => {
    const body = {
      type: 'storagebox',
      schedule: 'twice_daily',
      retentionDays: 14,
      objectLock: false,
      storagebox: {
        host: 'u1.your-storagebox.de',
        port: 23,
        username: 'u1',
        path: '/backups',
        authType: 'key',
        privateKey: SECRETS[2],
        password: SECRETS[3],
      },
    };
    const response = await service.update(dtoOf(body), USER, SOURCE);
    const sent = agent.requests.find((r) => r.method === 'PUT')?.body ?? '';
    expect(sent).toContain(SECRETS[2]);
    expect(sent).not.toContain(SECRETS[3]);
    expect(JSON.stringify([response, audit.log.mock.calls, prisma.state.row])).not.toContain(SECRETS[2]);
    expect(response.target).toMatchObject({ type: 'storagebox', host: 'u1.your-storagebox.de', port: 23, schedule: 'twice_daily' });
  });

  it('GET liefert Präfix, Pfad-Stil, Anmeldeart und Host-Key-Fingerabdruck vom Agent', async () => {
    await service.update(dtoOf(s3Body()), USER, SOURCE);
    agent.targetReply = {
      type: 's3',
      prefix: 'si/meins',
      pathStyle: true,
      authType: 'key',
      hostKeyFingerprint: 'SHA256:abc123',
      objectLock: true,
      ageRecipient: 'age1x',
    };
    const result = await service.get();
    expect(result.target).toMatchObject({
      prefix: 'si/meins',
      pathStyle: true,
      authType: 'key',
      hostKeyFingerprint: 'SHA256:abc123',
    });
  });

  it('PUT ohne Geheimfelder bei vorhandenem Ziel gleichen Typs: Agent bekommt keine Geheimnisse', async () => {
    await service.update(dtoOf(s3Body()), USER, SOURCE);
    const { accessKeyId: _a, secretAccessKey: _s, ...s3 } = s3Body().s3 as Record<string, unknown>;
    expect(await validate(dtoOf({ ...s3Body(), s3 }))).toEqual([]);
    await service.update(dtoOf({ ...s3Body(), s3 }), USER, SOURCE);
    const puts = agent.requests.filter((r) => r.method === 'PUT');
    const body = JSON.parse(puts[puts.length - 1]?.body ?? '{}') as { s3: Record<string, unknown> };
    expect(body.s3).not.toHaveProperty('accessKeyId');
    expect(body.s3).not.toHaveProperty('secretAccessKey');
    expect(body.s3['bucket']).toBe('meine-sicherung');
  });

  it('PUT ohne Geheimfelder OHNE vorhandenes Ziel oder bei anderem Typ: abgelehnt, Agent unberührt', async () => {
    const { accessKeyId: _a, secretAccessKey: _s, ...s3 } = s3Body().s3 as Record<string, unknown>;
    await expect(service.update(dtoOf({ ...s3Body(), s3 }), USER, SOURCE)).rejects.toBeInstanceOf(
      BackupSettingsInvalidError,
    );
    expect(agent.requests).toHaveLength(0);

    await service.update(dtoOf(s3Body()), USER, SOURCE);
    const before = agent.requests.length;
    const box = {
      type: 'storagebox',
      schedule: 'daily',
      retentionDays: 14,
      objectLock: false,
      storagebox: { host: 'h.example', port: 23, username: 'u', path: '/b', authType: 'key' },
    };
    await expect(service.update(dtoOf(box), USER, SOURCE)).rejects.toBeInstanceOf(BackupSettingsInvalidError);
    expect(agent.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    expect(agent.requests.length).toBeGreaterThanOrEqual(before);
  });

  it('Storage Box: Geheimnis nur weglassbar bei gleichem Typ und gleicher Anmeldeart', async () => {
    const box = (authType: string, extra: Record<string, unknown> = {}) => ({
      type: 'storagebox',
      schedule: 'daily',
      retentionDays: 14,
      objectLock: false,
      storagebox: { host: 'h.example', port: 23, username: 'u', path: '/b', authType, ...extra },
    });
    await service.update(dtoOf(box('key', { privateKey: SECRETS[2] })), USER, SOURCE);
    agent.targetReply = { type: 'storagebox', authType: 'key' };
    await service.update(dtoOf(box('key')), USER, SOURCE);
    const puts = agent.requests.filter((r) => r.method === 'PUT');
    expect(puts[puts.length - 1]?.body).not.toContain(SECRETS[2]);
    // Anmeldeart gewechselt: das neue Geheimnis fehlt wirklich.
    await expect(service.update(dtoOf(box('password')), USER, SOURCE)).rejects.toBeInstanceOf(
      BackupSettingsInvalidError,
    );
  });

  it('Geheimnis bleibt nur bei unveränderter Gegenstelle: Host, Port, Benutzer (Box) bzw. Endpunkt, Bucket (S3)', async () => {
    const box = (over: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      type: 'storagebox',
      schedule: 'daily',
      retentionDays: 14,
      objectLock: false,
      storagebox: { host: 'h.example', port: 23, username: 'u', path: '/b', authType: 'password', ...over, ...extra },
    });
    await service.update(dtoOf(box({}, { password: SECRETS[3] })), USER, SOURCE);
    agent.targetReply = { type: 'storagebox', authType: 'password' };
    for (const change of [{ host: 'fremd.example' }, { port: 2222 }, { username: 'anderer' }]) {
      const before = agent.requests.filter((r) => r.method === 'PUT').length;
      await expect(service.update(dtoOf(box(change)), USER, SOURCE)).rejects.toThrow(BackupSettingsInvalidError);
      expect(agent.requests.filter((r) => r.method === 'PUT')).toHaveLength(before);
    }
    // Mit neu eingegebenem Passwort darf der Host wechseln.
    await service.update(dtoOf(box({ host: 'neu.example' }, { password: 'neues-Passwort-1' })), USER, SOURCE);

    // S3: Endpunkt geändert, Geheimnisse weggelassen.
    const { accessKeyId: _a, secretAccessKey: _s, ...s3 } = s3Body().s3 as Record<string, unknown>;
    await service.update(dtoOf(s3Body()), USER, SOURCE);
    await expect(
      service.update(dtoOf({ ...s3Body(), s3: { ...s3, endpoint: 'https://fremd.example.com' } }), USER, SOURCE),
    ).rejects.toThrow(BackupSettingsInvalidError);
    await expect(
      service.update(dtoOf({ ...s3Body(), s3: { ...s3, bucket: 'anderer-bucket' } }), USER, SOURCE),
    ).rejects.toThrow(BackupSettingsInvalidError);
    await service.update(dtoOf({ ...s3Body(), s3 }), USER, SOURCE); // unverändert: geht
  });

  it('Host-Fingerabdruck wird geprüft und an den Agent weitergereicht', async () => {
    const fp = 'SHA256:' + 'A'.repeat(43);
    const body = (hostKeyFingerprint: string) => ({
      type: 'storagebox',
      schedule: 'daily',
      retentionDays: 14,
      objectLock: false,
      storagebox: { host: 'h.example', port: 23, username: 'u', path: '/b', authType: 'password', password: 'x', hostKeyFingerprint },
    });
    expect((await validate(dtoOf(body('MD5:00:11')))).length).toBeGreaterThan(0);
    expect(await validate(dtoOf(body(fp)))).toEqual([]);
    await service.update(dtoOf(body(fp)), USER, SOURCE);
    const puts = agent.requests.filter((r) => r.method === 'PUT');
    expect(JSON.parse(puts[puts.length - 1]?.body ?? '{}').storagebox.hostKeyFingerprint).toBe(fp);
  });

  it('Object Lock gibt es nur bei S3', async () => {
    const body = {
      type: 'storagebox',
      schedule: 'daily',
      retentionDays: 14,
      objectLock: true,
      storagebox: { host: 'h.example', port: 23, username: 'u', path: '/b', authType: 'password', password: 'x' },
    };
    await expect(service.update(dtoOf(body), USER, SOURCE)).rejects.toBeInstanceOf(BackupSettingsInvalidError);
  });
});

describe('BackupSettingsUpdateDto — Validierung', () => {
  async function problems(raw: Record<string, unknown>): Promise<string[]> {
    const errors = await validate(dtoOf(raw));
    const names: string[] = [];
    const walk = (list: typeof errors, prefix: string): void => {
      for (const e of list) {
        const name = prefix === '' ? e.property : `${prefix}.${e.property}`;
        if (e.constraints) names.push(name);
        if (e.children) walk(e.children, name);
      }
    };
    walk(errors, '');
    return names.sort();
  }

  it('nimmt eine vollständige S3-Eingabe an', async () => {
    expect(await problems(s3Body())).toEqual([]);
  });

  it('verlangt den Block zum gewählten Typ', async () => {
    const { s3: _s3, ...ohne } = s3Body();
    expect(await problems(ohne)).toEqual(['s3']);
  });

  it('lehnt unbekannten Typ, Zeitplan und unsinnige Aufbewahrung ab', async () => {
    expect(await problems({ ...s3Body(), type: 'ftp' })).toContain('type');
    expect(await problems({ ...s3Body(), schedule: 'hourly' })).toContain('schedule');
    expect(await problems({ ...s3Body(), retentionDays: 0 })).toContain('retentionDays');
    expect(await problems({ ...s3Body(), retentionDays: 99999 })).toContain('retentionDays');
  });

  it('lehnt unzulässige Endpunkte, Buckets und Pfade ab', async () => {
    const base = s3Body().s3 as Record<string, unknown>;
    expect(await problems({ ...s3Body(), s3: { ...base, endpoint: 'ftp://x' } })).toEqual(['s3.endpoint']);
    expect(await problems({ ...s3Body(), s3: { ...base, bucket: 'A_b' } })).toEqual(['s3.bucket']);
    expect(await problems({ ...s3Body(), s3: { ...base, prefix: 'a b;rm' } })).toEqual(['s3.prefix']);
  });
});
