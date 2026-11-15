import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/session.service';
import { BusinessError } from '../common/errors/business-error';
import type { InquirySource } from '../common/inquiry-source';
import { PrismaService } from '../prisma/prisma.service';
import { BackupAgentClient, scrub } from './backup-agent.client';
import { BackupAgentNotConfiguredError } from './backup-agent.errors';
import type { AgentTarget, AgentTargetUpdate } from './backup-agent.types';
import type { BackupSettingsUpdateDto } from './dto/backup-settings.dto';

/** Die Eingabe ist unstimmig (z. B. Schlüssel fehlt zur gewählten Anmeldeart). */
export class BackupSettingsInvalidError extends BusinessError {
  constructor(problems: string[]) {
    super(
      'backup_settings_invalid',
      'Die Sicherungseinstellungen sind nicht stimmig und wurden nicht gespeichert.',
      HttpStatus.BAD_REQUEST,
      { issues: problems },
    );
  }
}

/**
 * Was die Verwaltung über das Sicherungsziel weiß und anzeigt: NUR
 * unkritische Metadaten. Zugangsdaten stehen hier NIE.
 */
export interface BackupTargetMeta {
  type: 's3' | 'storagebox';
  endpoint: string | null;
  host: string | null;
  bucket: string | null;
  region: string | null;
  path: string | null;
  port: number | null;
  username: string | null;
  schedule: string;
  retentionDays: number;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  /** Vom Agent (GET /v1/target), nie Geheimnisse; null, solange der Agent nichts liefert. */
  prefix: string | null;
  pathStyle: boolean | null;
  authType: 'key' | 'password' | null;
  hostKeyFingerprint: string | null;
}

export interface BackupSettingsResponse {
  target: BackupTargetMeta | null;
  agent: {
    configured: boolean;
    reachable: boolean;
    version: string | null;
    targetConfigured: boolean | null;
    objectLock: boolean | null;
    ageRecipient: string | null;
  };
  /** NUR in der Antwort auf das ERSTE Einrichten, genau einmal; nie gespeichert. */
  ageIdentity?: string;
}

export interface BackupTestResponse {
  ok: boolean;
  message: string;
  testedAt: string;
}

const TEST_MESSAGE_MAX = 300;

type Actor = Pick<SessionUser, 'id' | 'username'>;

/**
 * Einstellungen → Sicherung.
 *
 * GEHEIMNISSE SIND WRITE-ONLY: Sie gehen aus der Anfrage direkt an den Agent.
 * Dieser Dienst legt sie weder in der Datenbank ab noch ins Audit-Log noch ins
 * Log noch in eine Antwort. Einzige Ausnahme ist der private age-Schlüssel, den
 * der Agent bei der ERSTEN Einrichtung liefert: Er steht genau einmal in der
 * Antwort auf das Speichern und wird nirgends festgehalten.
 */
@Injectable()
export class BackupSettingsService {
  private readonly logger = new Logger(BackupSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly agent: BackupAgentClient,
  ) {}

  async get(): Promise<BackupSettingsResponse> {
    const { agent, target } = await this.agentStatus();
    return { target: await this.readTarget(target), agent };
  }

  async update(
    dto: BackupSettingsUpdateDto,
    user: Actor,
    source: InquirySource,
  ): Promise<BackupSettingsResponse> {
    const update = await this.buildAgentUpdate(dto);

    // ERST der Agent, DANN die eigene Zeile: scheitert der Agent (503/502),
    // bleibt die Verwaltung unverändert — kein Zustand, den der Agent nicht teilt.
    const result = await this.agent.putTarget(update);

    const meta = {
      type: dto.type,
      endpoint: dto.type === 's3' ? (dto.s3?.endpoint ?? null) : null,
      host: dto.type === 'storagebox' ? (dto.storagebox?.host ?? null) : null,
      bucket: dto.type === 's3' ? (dto.s3?.bucket ?? null) : null,
      region: dto.type === 's3' ? (dto.s3?.region ?? null) : null,
      path: dto.type === 's3' ? (dto.s3?.prefix ?? null) : (dto.storagebox?.path ?? null),
      port: dto.type === 'storagebox' ? (dto.storagebox?.port ?? null) : null,
      username: dto.type === 'storagebox' ? (dto.storagebox?.username ?? null) : null,
      schedule: dto.schedule,
      retentionDays: dto.retentionDays,
    };
    const before = await this.readTarget();
    await this.prisma.backupTarget.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', ...meta },
      // Eine geänderte Konfiguration ist ungetestet.
      update: { ...meta, lastTestAt: null, lastTestOk: null, lastTestMessage: null },
    });
    await this.audit.log({
      userId: user.id,
      actor: user.username,
      action: AUDIT_ACTION.backupTargetUpdated,
      objectType: 'BackupTarget',
      objectId: 'singleton',
      beforeValue: before === null ? null : metaForAudit(before),
      afterValue: {
        ...meta,
        objectLock: dto.objectLock,
        ageRecipient: result.ageRecipient,
        firstSetup: typeof result.ageIdentity === 'string',
      },
      ip: source.ip,
      userAgent: source.userAgent,
    });

    const status = await this.agentStatus();
    const response: BackupSettingsResponse = {
      target: await this.readTarget(status.target),
      agent: status.agent,
    };
    if (typeof result.ageIdentity === 'string' && result.ageIdentity !== '') {
      response.ageIdentity = result.ageIdentity;
    }
    return response;
  }

  async test(user: Actor, source: InquirySource): Promise<BackupTestResponse> {
    let ok = false;
    let message: string;
    let failure: unknown = null;
    try {
      const result = await this.agent.testTarget();
      ok = result.ok === true;
      message = scrub(String(result.message ?? '')).slice(0, TEST_MESSAGE_MAX);
    } catch (exception) {
      failure = exception;
      message =
        exception instanceof BackupAgentNotConfiguredError
          ? 'Der Sicherungs-Agent ist nicht eingerichtet.'
          : 'Der Sicherungs-Agent hat nicht geantwortet.';
    }
    const testedAt = new Date();
    // `updateMany`: gibt es noch kein Ziel, gibt es nichts zu vermerken.
    await this.prisma.backupTarget.updateMany({
      where: { id: 'singleton' },
      data: { lastTestAt: testedAt, lastTestOk: ok, lastTestMessage: message },
    });
    await this.audit.log({
      userId: user.id,
      actor: user.username,
      action: AUDIT_ACTION.backupTargetTested,
      objectType: 'BackupTarget',
      objectId: 'singleton',
      afterValue: { ok, message },
      ip: source.ip,
      userAgent: source.userAgent,
    });
    // Ein nicht erreichbarer Agent ist ein Fehler (503), kein „Test nicht bestanden".
    if (failure !== null) throw failure;
    return { ok, message, testedAt: testedAt.toISOString() };
  }

  /**
   * Baut den Body für den Agent. Geheimfelder dürfen NUR weggelassen werden,
   * wenn es bereits ein Ziel gleichen Typs gibt (bei der Storage Box
   * zusätzlich mit gleicher Anmeldeart): Dann behält der Agent sie. Sonst
   * fehlen sie wirklich und die Eingabe ist unstimmig.
   */
  private async buildAgentUpdate(dto: BackupSettingsUpdateDto): Promise<AgentTargetUpdate> {
    const problems: string[] = [];
    const update: AgentTargetUpdate = {
      type: dto.type,
      schedule: dto.schedule,
      retentionDays: dto.retentionDays,
      objectLock: dto.objectLock,
    };
    const existing = await this.readTarget(null);
    const sameType = existing !== null && existing.type === dto.type;

    if (dto.type === 's3' && dto.s3) {
      const accessKeyId = nonEmpty(dto.s3.accessKeyId);
      const secretAccessKey = nonEmpty(dto.s3.secretAccessKey);
      if ((accessKeyId === undefined) !== (secretAccessKey === undefined)) {
        problems.push('Zugangskennung und geheimer Zugangsschlüssel gehören zusammen: entweder beide oder keines von beiden angeben.');
      } else if (accessKeyId === undefined && !sameType) {
        problems.push('Die Zugangskennung und der geheime Zugangsschlüssel fehlen.');
      }
      update.s3 = {
        endpoint: dto.s3.endpoint,
        region: dto.s3.region,
        bucket: dto.s3.bucket,
        prefix: dto.s3.prefix,
        pathStyle: dto.s3.pathStyle,
        ...(accessKeyId !== undefined && secretAccessKey !== undefined
          ? { accessKeyId, secretAccessKey }
          : {}),
      };
    }
    if (dto.type === 'storagebox' && dto.storagebox) {
      const b = dto.storagebox;
      const secret = nonEmpty(b.authType === 'key' ? b.privateKey : b.password);
      if (secret === undefined) {
        // Behalten geht nur bei gleichem Typ UND gleicher Anmeldeart.
        let keepable = false;
        if (sameType) {
          const current = await this.agent.getTarget();
          keepable = current.authType === b.authType;
        }
        if (!keepable) {
          problems.push(
            b.authType === 'key'
              ? 'Für die Anmeldung per Schlüssel fehlt der private Schlüssel.'
              : 'Für die Anmeldung per Passwort fehlt das Passwort.',
          );
        }
      }
      update.storagebox = {
        host: b.host,
        port: b.port,
        username: b.username,
        path: b.path,
        authType: b.authType,
        ...(secret === undefined
          ? {}
          : b.authType === 'key'
            ? { privateKey: secret }
            : { password: secret }),
      };
    }
    if (dto.objectLock && dto.type !== 's3') {
      problems.push('Object Lock gibt es nur bei einem S3-Ziel.');
    }
    if (problems.length > 0) throw new BackupSettingsInvalidError(problems);
    return update;
  }

  private async readTarget(fromAgent: AgentTarget | null = null): Promise<BackupTargetMeta | null> {
    const row = await this.prisma.backupTarget.findUnique({ where: { id: 'singleton' } });
    if (row === null) return null;
    const agentTarget = fromAgent ?? {};
    return {
      type: row.type as 's3' | 'storagebox',
      endpoint: row.endpoint,
      host: row.host,
      bucket: row.bucket,
      region: row.region,
      path: row.path,
      port: row.port,
      username: row.username,
      schedule: row.schedule,
      retentionDays: row.retentionDays,
      lastTestAt: row.lastTestAt?.toISOString() ?? null,
      lastTestOk: row.lastTestOk,
      lastTestMessage: row.lastTestMessage,
      // Der Agent kennt die Einzelheiten (die Verwaltung speichert sie nicht).
      // Beim S3-Ziel ist der Pfad der Zeile das Präfix.
      prefix:
        typeof agentTarget.prefix === 'string'
          ? agentTarget.prefix
          : row.type === 's3'
            ? row.path
            : null,
      pathStyle: typeof agentTarget.pathStyle === 'boolean' ? agentTarget.pathStyle : null,
      authType:
        agentTarget.authType === 'key' || agentTarget.authType === 'password'
          ? agentTarget.authType
          : null,
      hostKeyFingerprint:
        typeof agentTarget.hostKeyFingerprint === 'string'
          ? agentTarget.hostKeyFingerprint.slice(0, 200)
          : null,
    };
  }

  /** Ein Ausfall des Agents macht die Seite nicht unlesbar — er wird angezeigt. */
  private async agentStatus(): Promise<{
    agent: BackupSettingsResponse['agent'];
    target: AgentTarget | null;
  }> {
    const none = {
      configured: this.agent.isConfigured(),
      reachable: false,
      version: null,
      targetConfigured: null,
      objectLock: null,
      ageRecipient: null,
    };
    if (!none.configured) return { agent: none, target: null };
    try {
      const health = await this.agent.health();
      let target: AgentTarget = {};
      if (health.targetConfigured) {
        try {
          target = await this.agent.getTarget();
        } catch {
          target = {};
        }
      }
      return {
        agent: {
          configured: true,
          reachable: true,
          version: typeof health.version === 'string' ? health.version.slice(0, 40) : null,
          targetConfigured: health.targetConfigured === true,
          objectLock: typeof target.objectLock === 'boolean' ? target.objectLock : null,
          ageRecipient: typeof target.ageRecipient === 'string' ? target.ageRecipient : null,
        },
        target,
      };
    } catch (exception) {
      this.logger.warn(
        `Sicherungs-Agent nicht abfragbar: ${exception instanceof Error ? exception.constructor.name : 'Fehler'}`,
      );
      return { agent: none, target: null };
    }
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function metaForAudit(meta: BackupTargetMeta): Record<string, unknown> {
  const { lastTestMessage: _message, ...rest } = meta;
  return rest;
}
