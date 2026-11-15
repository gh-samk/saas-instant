import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '.prisma/control-client';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import { BackupAgentClient, scrub } from '../backup-settings/backup-agent.client';
import {
  BackupAgentUnavailableError,
  BackupNotDeclaredError,
} from '../backup-settings/backup-agent.errors';
import type { AgentInstance, AgentJob } from '../backup-settings/backup-agent.types';
import type { InquirySource } from '../common/inquiry-source';
import { CoolifyConfigService, instanceHost } from '../coolify/coolify.config';
import { normalizeSubdomain, subdomainError } from '../coolify/subdomain';
import { CryptoService } from '../crypto/crypto.service';
import { composeProjectFor } from '../manifest/sections/provisioning';
import { ManifestService } from '../manifest/manifest.service';
import { writeSystemNote } from '../notes/system-note';
import { PrismaService } from '../prisma/prisma.service';
import {
  PROVISIONER,
  ProvisioningFailedError,
  WAIT,
  type Provisioner,
  type Wait,
} from '../provisioning/provisioner';
import { agentInstanceFor } from './backup-plan';
import { buildInstanceEnvironment } from './instance-environment';
import {
  AdoptStopFailedError,
  BackupNotFoundError,
  BackupNotRestorableError,
  BackupPlanIncompleteError,
  RestoreConfirmationError,
  RestoreInProgressError,
  RestoreNotAdoptableError,
  RestoreNotFoundError,
  RestoreTokensMissingError,
} from './instance-restore.errors';
import { HEALTH_CHECK, HEALTH_INTERVAL_MS, type HealthCheck } from './instance-provisioning.service';
import {
  InstanceNotFoundError,
  InstanceSendMissingError,
  InstanceStatusMismatchError,
  SubdomainInvalidError,
  SubdomainTakenError,
} from './instance.errors';
import { HEALTH_TIMEOUT_S } from './instance.rules';
import { InstanceService } from './instance.service';
import type { RestoreStartDto } from './dto/instance-backup.dto';

/** Wie oft und wie lange der Agent-Auftrag abgefragt wird. */
export const RESTORE_POLL_INTERVAL_MS = 5_000;
export const RESTORE_POLL_MAX_ATTEMPTS = 720; // eine Stunde
/** So viele Abfragen in Folge dürfen scheitern, bevor die Wiederherstellung als gescheitert gilt. */
export const RESTORE_POLL_MAX_FAILURES = 12;

export interface RestoreView {
  id: string;
  instanceId: string;
  backupId: string;
  newSubdomain: string;
  /** provisioning | restoring | ready | failed | adopted */
  status: string;
  message: string | null;
  createdAt: string;
  adoptedAt: string | null;
}

interface Actor {
  userId: string | null;
  name: string;
}

function viewOf(row: {
  id: string;
  instanceId: string;
  backupId: string;
  newSubdomain: string;
  status: string;
  message: string | null;
  createdAt: Date;
  adoptedAt: Date | null;
}): RestoreView {
  return {
    id: row.id,
    instanceId: row.instanceId,
    backupId: row.backupId,
    newSubdomain: row.newSubdomain,
    status: row.status,
    message: row.message,
    createdAt: row.createdAt.toISOString(),
    adoptedAt: row.adoptedAt?.toISOString() ?? null,
  };
}

/**
 * Wiederherstellung einer Sicherung als NEUE Instanz — und ihre Übernahme.
 *
 * ABLAUF: Prüfungen → Zeile `InstanceRestore` (`provisioning`) → NEUE
 * Coolify-Anwendung über den Provisioner (nur `create`, KEINE neue
 * `Instance`-Zeile, denn `companyId` ist eindeutig) → Agent-Auftrag „restore"
 * (`restoring`) → Gesundheitsprüfung → `ready`. Die alte Instanz bleibt
 * unberührt, bis ein Mensch die Übernahme auslöst.
 *
 * DER PRIVATE age-SCHLÜSSEL (`ageIdentity`) ist WRITE-ONLY: Er lebt nur als
 * Argument dieser Methoden im Arbeitsspeicher, geht an den Agent und wird nie
 * gespeichert, protokolliert oder zurückgegeben; Fehlertexte werden von ihm
 * gesäubert.
 *
 * NICHTS WIRD GELÖSCHT (R1/R4). Die Übernahme STOPPT die alte Instanz und stellt
 * Kennungen um; die alte Anwendung und ihre Daten bleiben in Coolify.
 */
@Injectable()
export class InstanceRestoreService {
  private readonly logger = new Logger(InstanceRestoreService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly coolifyConfig: CoolifyConfigService,
    @Inject(PROVISIONER) private readonly provisioner: Provisioner,
    @Inject(WAIT) private readonly wait: Wait,
    @Inject(HEALTH_CHECK) private readonly checkHealth: HealthCheck,
    private readonly crypto: CryptoService,
    private readonly instances: InstanceService,
    private readonly agent: BackupAgentClient,
    private readonly manifest: ManifestService,
  ) {}

  async list(instanceId: string): Promise<RestoreView[]> {
    const exists = await this.prisma.instance.findUnique({
      where: { id: instanceId },
      select: { id: true },
    });
    if (exists === null) throw new InstanceNotFoundError();
    const rows = await this.prisma.instanceRestore.findMany({
      where: { instanceId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map(viewOf);
  }

  /** Prüft alles Prüfbare, legt die Zeile an und startet den Hintergrundlauf. */
  async start(
    instanceId: string,
    dto: RestoreStartDto,
    actor: Actor,
    source: InquirySource,
  ): Promise<RestoreView> {
    const instance = await this.prisma.instance.findUnique({
      where: { id: instanceId },
      select: {
        id: true,
        subdomain: true,
        status: true,
        metricsTokenEncrypted: true,
        setupTokenEncrypted: true,
      },
    });
    if (instance === null) throw new InstanceNotFoundError();
    if (instance.status === 'provisioning') {
      throw new InstanceStatusMismatchError(instance.status, 'active|stopped|archived');
    }

    // Die Bestätigung gilt dieser Instanz — ein Tippfehler startet nichts.
    if (dto.confirmName.trim().toLowerCase() !== instance.subdomain) {
      throw new RestoreConfirmationError();
    }

    const backup = await this.prisma.backup.findFirst({
      where: { id: dto.backupId, instanceId },
      select: { id: true, kind: true, objectKey: true, status: true },
    });
    if (backup === null) throw new BackupNotFoundError();
    if (backup.kind !== 'instance' || backup.objectKey === null || backup.status !== 'ok') {
      throw new BackupNotRestorableError();
    }

    const declaration = this.manifest.provisioning.backup;
    if (declaration === null) throw new BackupNotDeclaredError();

    const newSubdomain = normalizeSubdomain(dto.newSubdomain);
    const reason = subdomainError(newSubdomain);
    if (reason !== null) throw new SubdomainInvalidError(reason);
    // CRM UND Coolify (im Zweifel „vergeben"), plus bereits geplante Wiederherstellungen.
    const free = await this.instances.checkSubdomain(newSubdomain);
    const planned = await this.prisma.instanceRestore.findUnique({
      where: { newSubdomain },
      select: { id: true },
    });
    if (!free.available || planned !== null) throw new SubdomainTakenError(newSubdomain);

    const running = await this.prisma.instanceRestore.findFirst({
      where: { instanceId, status: { in: ['provisioning', 'restoring'] } },
      select: { id: true },
    });
    if (running !== null) throw new RestoreInProgressError();

    // Die neue Anwendung bekommt dieselben Geheimnisse wie die alte, damit die
    // Instanz-Zeile nach der Übernahme ohne Umschlüsseln weiterpasst.
    const secrets = this.tokensOf(instance);
    const config = this.coolifyConfig.read();
    if (config !== null && config.instanceSmtp === null) throw new InstanceSendMissingError();

    let row;
    try {
      row = await this.prisma.instanceRestore.create({
        data: {
          instanceId,
          backupId: backup.id,
          newSubdomain,
          status: 'provisioning',
          message: 'Neue Anwendung wird in Coolify angelegt …',
        },
      });
    } catch (exception) {
      if (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2002') {
        throw new SubdomainTakenError(newSubdomain);
      }
      throw exception;
    }

    await this.audit.log({
      userId: actor.userId,
      actor: actor.name,
      action: AUDIT_ACTION.instanceRestoreStarted,
      objectType: 'Instance',
      objectId: instanceId,
      // Bewusst OHNE Schlüssel; objectKey ist kein Geheimnis.
      afterValue: {
        restoreId: row.id,
        backupId: backup.id,
        objectKey: backup.objectKey,
        newSubdomain,
        fromSubdomain: instance.subdomain,
      },
      ip: source.ip,
      userAgent: source.userAgent,
    });

    const objectKey = backup.objectKey;
    void this.carryOut(row.id, newSubdomain, objectKey, dto.ageIdentity, secrets).catch(
      (exception: unknown) => {
        const text = exception instanceof Error ? exception.message : String(exception);
        this.logger.error(`Wiederherstellung ${row.id} abgebrochen: ${scrub(text, [dto.ageIdentity])}`);
      },
    );
    return viewOf(row);
  }

  /**
   * Übernahme: die alte Instanz wird GESTOPPT (nie gelöscht), danach stellt eine
   * Transaktion Subdomain und Coolify-Kennungen der Instanz-Zeile auf die
   * wiederhergestellte Anwendung um. Die alten Werte stehen im Audit-Log.
   */
  async adopt(
    instanceId: string,
    restoreId: string,
    actor: Actor,
    source: InquirySource,
  ): Promise<RestoreView> {
    const restore = await this.prisma.instanceRestore.findFirst({
      where: { id: restoreId, instanceId },
    });
    if (restore === null) throw new RestoreNotFoundError();
    if (restore.status !== 'ready' || restore.coolifyApplicationId === null) {
      throw new RestoreNotAdoptableError(
        'Nur eine Wiederherstellung im Zustand „bereit" lässt sich übernehmen.',
      );
    }
    const old = await this.prisma.instance.findUnique({ where: { id: instanceId } });
    if (old === null) throw new InstanceNotFoundError();
    if (old.status === 'provisioning') {
      throw new InstanceStatusMismatchError(old.status, 'active|stopped|archived');
    }

    // 1. Die alte Instanz anhalten. Scheitert das, ist NICHTS umgestellt.
    //    Stoppen ist wiederholbar; ein zweiter, gleichzeitiger Aufruf gewinnt
    //    nicht gegen die bedingte Umstellung unten.
    if (old.coolifyApplicationId !== null && (old.status === 'active' || old.status === 'stopped')) {
      try {
        await this.provisioner.stop(old.coolifyApplicationId);
      } catch (exception) {
        const text = exception instanceof Error ? exception.message : String(exception);
        this.logger.error(`Übernahme ${restoreId}: alte Instanz nicht stoppbar: ${scrub(text)}`);
        throw new AdoptStopFailedError();
      }
    }

    const before = {
      subdomain: old.subdomain,
      coolifyApplicationId: old.coolifyApplicationId,
      coolifyDatabaseId: old.coolifyDatabaseId,
      status: old.status,
    };
    const after = {
      subdomain: restore.newSubdomain,
      coolifyApplicationId: restore.coolifyApplicationId,
      coolifyDatabaseId: null,
      status: 'active',
    };

    // 2. ALLES oder nichts: Zeile umstellen, Wiederherstellung abschließen,
    //    Audit und Verlauf — in EINER Transaktion.
    try {
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.instanceRestore.updateMany({
          where: { id: restoreId, instanceId, status: 'ready' },
          data: { status: 'adopted', adoptedAt: new Date(), message: 'Übernommen.' },
        });
        if (claimed.count !== 1) {
          throw new RestoreNotAdoptableError('Die Wiederherstellung wurde bereits übernommen.');
        }
        const moved = await tx.instance.updateMany({
          // Nur, wenn die Zeile noch so aussieht wie vorhin gelesen.
          where: {
            id: instanceId,
            subdomain: old.subdomain,
            coolifyApplicationId: old.coolifyApplicationId,
          },
          data: {
            subdomain: after.subdomain,
            coolifyApplicationId: after.coolifyApplicationId,
            coolifyDatabaseId: null,
            status: 'active',
            archivedAt: null,
            message: null,
          },
        });
        if (moved.count !== 1) {
          throw new RestoreNotAdoptableError(
            'Die Instanz hat sich inzwischen geändert; die Übernahme wurde nicht ausgeführt.',
          );
        }
        await this.audit.log(
          {
            userId: actor.userId,
            actor: actor.name,
            action: AUDIT_ACTION.instanceRestoreAdopted,
            objectType: 'Instance',
            objectId: instanceId,
            beforeValue: before,
            afterValue: { ...after, restoreId },
            ip: source.ip,
            userAgent: source.userAgent,
          },
          tx,
        );
        await writeSystemNote(
          tx,
          old.companyId,
          `Wiederhergestellte Instanz übernommen: ${old.subdomain} → ${restore.newSubdomain}. ` +
            'Die alte Anwendung wurde gestoppt, NICHT gelöscht; sie steht weiterhin in Coolify.',
        );
      });
    } catch (exception) {
      if (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2002') {
        throw new SubdomainTakenError(restore.newSubdomain);
      }
      throw exception;
    }

    const done = await this.prisma.instanceRestore.findUnique({ where: { id: restoreId } });
    if (done === null) throw new RestoreNotFoundError();
    return viewOf(done);
  }

  // --------------------------------------------------------------------------
  // Hintergrundlauf
  // --------------------------------------------------------------------------

  private tokensOf(instance: {
    metricsTokenEncrypted: string | null;
    setupTokenEncrypted: string | null;
  }): { metricsToken: string; setupToken: string } {
    try {
      if (instance.metricsTokenEncrypted === null || instance.setupTokenEncrypted === null) {
        throw new Error('fehlt');
      }
      return {
        metricsToken: this.crypto.decrypt(instance.metricsTokenEncrypted),
        setupToken: this.crypto.decrypt(instance.setupTokenEncrypted),
      };
    } catch {
      throw new RestoreTokensMissingError();
    }
  }

  private async carryOut(
    restoreId: string,
    newSubdomain: string,
    objectKey: string,
    ageIdentity: string,
    secrets: { metricsToken: string; setupToken: string },
  ): Promise<void> {
    const contract = this.coolifyConfig.contract();
    const host = instanceHost(contract, newSubdomain);
    const declaration = this.manifest.provisioning.backup;
    try {
      if (declaration === null) throw new BackupNotDeclaredError();
      const environment = buildInstanceEnvironment({
        host,
        subdomain: newSubdomain,
        smtp: this.coolifyConfig.read()?.instanceSmtp ?? null,
        secrets,
        templates: this.coolifyConfig.instanceEnvTemplates(),
      });

      // NUR `create` — keine neue Instanz-Zeile, kein Löschen, kein Überschreiben.
      const created = await this.provisioner.create(
        { name: `${contract.instancePrefix}-${newSubdomain}`, host, environment },
        {
          onProgress: (text) => this.setMessage(restoreId, text),
          onCreated: async (ref) => {
            await this.prisma.instanceRestore.update({
              where: { id: restoreId },
              data: { coolifyApplicationId: ref },
            });
          },
        },
      );

      await this.prisma.instanceRestore.update({
        where: { id: restoreId },
        data: {
          status: 'restoring',
          coolifyApplicationId: created.ref,
          message: 'Die Daten werden eingespielt …',
        },
      });

      const target = agentInstanceFor(declaration, {
        subdomain: newSubdomain,
        coolifyApplicationId: created.ref,
      });
      if (target === null) throw new BackupPlanIncompleteError();
      const jobId = await this.startAgentJob(objectKey, ageIdentity, target);
      const job = await this.pollJob(jobId, ageIdentity);
      if (job.status !== 'succeeded') {
        const detail = typeof job.message === 'string' ? `: ${job.message}` : '.';
        throw new Error(`Der Sicherungs-Agent meldet einen Fehler beim Einspielen${detail}`);
      }

      await this.setMessage(restoreId, 'Warte auf Gesundheitsprüfung …');
      if (!(await this.waitOnHealth(host, contract.healthPath))) {
        throw new Error(
          `Die Daten sind eingespielt, aber https://${host}${contract.healthPath} antwortet nicht. ` +
            'Bitte in Coolify nachsehen',
        );
      }
      await this.prisma.instanceRestore.update({
        where: { id: restoreId },
        data: {
          status: 'ready',
          message: 'Wiederhergestellt. Die alte Instanz läuft unverändert weiter und wartet auf die Übernahme.',
        },
      });
    } catch (exception) {
      const raw =
        exception instanceof ProvisioningFailedError || exception instanceof Error
          ? exception.message
          : String(exception);
      await this.fail(restoreId, raw, [ageIdentity, secrets.metricsToken, secrets.setupToken]);
    }
  }

  private async startAgentJob(
    objectKey: string,
    ageIdentity: string,
    target: AgentInstance,
  ): Promise<string> {
    const { jobId } = await this.agent.startJob({ kind: 'restore', objectKey, ageIdentity, target });
    return jobId;
  }

  private async pollJob(jobId: string, ageIdentity: string): Promise<AgentJob> {
    let failures = 0;
    for (let attempt = 0; attempt < RESTORE_POLL_MAX_ATTEMPTS; attempt += 1) {
      try {
        const job = await this.agent.getJob(jobId);
        failures = 0;
        if (job.status === 'succeeded' || job.status === 'failed') {
          return { ...job, message: job.message ? scrub(job.message, [ageIdentity]).slice(0, 300) : undefined };
        }
      } catch (exception) {
        failures += 1;
        if (failures >= RESTORE_POLL_MAX_FAILURES) {
          throw exception instanceof BackupAgentUnavailableError
            ? exception
            : new Error('Der Sicherungs-Agent lässt sich nicht mehr abfragen');
        }
      }
      await this.wait(RESTORE_POLL_INTERVAL_MS);
    }
    throw new Error('Der Sicherungs-Agent meldet nach einer Stunde noch kein Ergebnis');
  }

  private async waitOnHealth(host: string, path: string): Promise<boolean> {
    const attempts = Math.ceil((HEALTH_TIMEOUT_S * 1000) / HEALTH_INTERVAL_MS);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await this.checkHealth(host, path)) return true;
      await this.wait(HEALTH_INTERVAL_MS);
    }
    return false;
  }

  private async setMessage(restoreId: string, text: string): Promise<void> {
    await this.prisma.instanceRestore.update({ where: { id: restoreId }, data: { message: text } });
  }

  /** Scheitern ist SICHTBAR: Zeile `failed` mit Klartext (ohne Geheimnisse) und Audit. */
  private async fail(restoreId: string, raw: string, secrets: string[]): Promise<void> {
    const text = `Fehlgeschlagen: ${scrub(raw, secrets).slice(0, 400)}. Es wurde nichts gelöscht.`;
    this.logger.error(`Wiederherstellung ${restoreId}: ${text}`);
    await this.prisma.instanceRestore.update({
      where: { id: restoreId },
      data: { status: 'failed', message: text },
    });
    await this.audit.log({
      userId: null,
      actor: 'instanz-wiederherstellung',
      action: AUDIT_ACTION.instanceProvisioningError,
      objectType: 'InstanceRestore',
      objectId: restoreId,
      afterValue: { message: text },
    });
  }
}
