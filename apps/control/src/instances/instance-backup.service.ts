import { Injectable } from '@nestjs/common';
import { dateStringFromDate } from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import { BackupAgentClient, scrub } from '../backup-settings/backup-agent.client';
import { BackupNotDeclaredError } from '../backup-settings/backup-agent.errors';
import type { AgentBackupEntry, AgentJob } from '../backup-settings/backup-agent.types';
import type { InquirySource } from '../common/inquiry-source';
import { ManifestService } from '../manifest/manifest.service';
import { PrismaService } from '../prisma/prisma.service';
import { agentInstanceFor } from './backup-plan';
import {
  BackupNotFoundError,
  BackupNotRestorableError,
  BackupPlanIncompleteError,
} from './instance-restore.errors';
import { InstanceNotFoundError, InstanceStatusMismatchError } from './instance.errors';

export interface InstanceBackupRow {
  id: string;
  date: string;
  sizeBytes: number;
  objectKey: string | null;
  sha256: string | null;
  verified: boolean;
  verifiedAt: string | null;
  restorable: boolean;
}

export interface InstanceBackupList {
  backups: InstanceBackupRow[];
  /** Nur mit `includeAgent`: was der Agent selbst im Ziel sieht (Gegenprobe). */
  agent?: { available: boolean; items: AgentBackupEntry[] };
}

export interface JobView {
  id: string;
  kind: AgentJob['kind'];
  status: AgentJob['status'];
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
  result: { objectKey?: string; sizeBytes?: number; sha256?: string } | null;
}

/** Eine Job-Kennung ist eine UUID o. ä. — nie etwas, das den Pfad verändern könnte. */
const JOB_ID = /^[A-Za-z0-9_-]{8,64}$/;

interface Actor {
  userId: string | null;
  name: string;
}

/**
 * Sicherungen einer Instanz: ansehen, jetzt sichern, prüfen lassen.
 *
 * DIE VERWALTUNG STÖSST AN, DER AGENT ARBEITET. Hier gibt es keinen
 * Löschweg, keinen Dump und keinen Zugang zum Sicherungsziel.
 */
@Injectable()
export class InstanceBackupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly agent: BackupAgentClient,
    private readonly manifest: ManifestService,
  ) {}

  async list(instanceId: string, includeAgent: boolean): Promise<InstanceBackupList> {
    const instance = await this.prisma.instance.findUnique({
      where: { id: instanceId },
      select: { id: true, subdomain: true },
    });
    if (instance === null) throw new InstanceNotFoundError();

    const rows = await this.prisma.backup.findMany({
      where: { instanceId, kind: 'instance' },
      orderBy: { date: 'desc' },
      take: 200,
    });
    const result: InstanceBackupList = {
      backups: rows.map((row) => ({
        id: row.id,
        date: dateStringFromDate(row.date),
        sizeBytes: Number(row.sizeBytes),
        objectKey: row.objectKey,
        sha256: row.sha256,
        verified: row.verifiedAt !== null,
        verifiedAt: row.verifiedAt?.toISOString() ?? null,
        restorable: row.objectKey !== null && row.status === 'ok',
      })),
    };
    if (includeAgent) {
      try {
        const items = await this.agent.listBackups({
          kind: 'instance',
          subdomain: instance.subdomain,
        });
        result.agent = { available: true, items: Array.isArray(items) ? items : [] };
      } catch {
        // Die Liste der Verwaltung bleibt lesbar, auch wenn der Agent fehlt.
        result.agent = { available: false, items: [] };
      }
    }
    return result;
  }

  /** „Jetzt sichern": legt beim Agent einen Auftrag an und gibt dessen Kennung zurück. */
  async trigger(
    instanceId: string,
    actor: Actor,
    source: InquirySource,
  ): Promise<{ jobId: string }> {
    const instance = await this.prisma.instance.findUnique({
      where: { id: instanceId },
      select: { id: true, subdomain: true, status: true, coolifyApplicationId: true },
    });
    if (instance === null) throw new InstanceNotFoundError();
    if (instance.status !== 'active') {
      throw new InstanceStatusMismatchError(instance.status, 'active');
    }
    const declaration = this.manifest.provisioning.backup;
    if (declaration === null) throw new BackupNotDeclaredError();
    const target = agentInstanceFor(declaration, instance);
    if (target === null) throw new BackupPlanIncompleteError();

    const { jobId } = await this.agent.startJob({ kind: 'backup', instance: target });
    await this.audit.log({
      userId: actor.userId,
      actor: actor.name,
      action: AUDIT_ACTION.backupJobTriggered,
      objectType: 'Instance',
      objectId: instance.id,
      afterValue: { kind: 'backup', subdomain: instance.subdomain, jobId },
      ip: source.ip,
      userAgent: source.userAgent,
    });
    return { jobId };
  }

  /** Prüfung einer gemeldeten Sicherung beim Agent anstoßen (kein Entschlüsseln). */
  async verify(
    instanceId: string,
    backupId: string,
    actor: Actor,
    source: InquirySource,
  ): Promise<{ jobId: string }> {
    const backup = await this.prisma.backup.findFirst({
      where: { id: backupId, instanceId },
      select: { id: true, objectKey: true },
    });
    if (backup === null) throw new BackupNotFoundError();
    if (backup.objectKey === null) throw new BackupNotRestorableError();

    const { jobId } = await this.agent.startJob({ kind: 'verify', objectKey: backup.objectKey });
    await this.audit.log({
      userId: actor.userId,
      actor: actor.name,
      action: AUDIT_ACTION.backupJobTriggered,
      objectType: 'Backup',
      objectId: backup.id,
      afterValue: { kind: 'verify', instanceId, objectKey: backup.objectKey, jobId },
      ip: source.ip,
      userAgent: source.userAgent,
    });
    return { jobId };
  }

  /**
   * Stand eines Auftrags beim Agent. Ist es eine gelungene Prüfung zu einer
   * Sicherung dieser Instanz (`backupId`) UND meldet der Agent genau deren
   * Objektschlüssel, wird die Sicherung als geprüft vermerkt.
   */
  async job(instanceId: string, jobId: string, backupId?: string): Promise<JobView> {
    if (!JOB_ID.test(jobId)) throw new BackupNotFoundError();
    const job = await this.agent.getJob(jobId);

    if (
      backupId !== undefined &&
      job.kind === 'verify' &&
      job.status === 'succeeded' &&
      typeof job.result?.objectKey === 'string'
    ) {
      await this.prisma.backup.updateMany({
        where: {
          id: backupId,
          instanceId,
          objectKey: job.result.objectKey,
          verifiedAt: null,
        },
        data: { verifiedAt: new Date() },
      });
    }
    return viewOf(job);
  }
}

export function viewOf(job: AgentJob): JobView {
  return {
    id: String(job.id),
    kind: job.kind,
    status: job.status,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    message: typeof job.message === 'string' ? scrub(job.message).slice(0, 300) : null,
    result: job.result
      ? {
          ...(typeof job.result.objectKey === 'string' ? { objectKey: job.result.objectKey } : {}),
          ...(typeof job.result.sizeBytes === 'number' ? { sizeBytes: job.result.sizeBytes } : {}),
          ...(typeof job.result.sha256 === 'string' ? { sha256: job.result.sha256 } : {}),
        }
      : null,
  };
}
