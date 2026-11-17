import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '.prisma/control-client';
import { Cron } from '@nestjs/schedule';
import { PURGE_DAYS, dateStringFromDate, datePlusDays, deletionDay, today, toDate } from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService, type AuditAction } from '../audit/audit.service';
import { dayReadable } from '../common/calendar';
import { CompanyNotDeletableError } from '../companies/company.errors';
import { CompanyService, type Actor } from '../companies/company.service';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { PROVISIONER, type Provisioner } from '../provisioning/provisioner';
import { VaultService } from '../vault/vault.service';
import { endedCompany, expiredArchive, expiredArchiveCoolifyGone } from './expired-archive';

/** Wie viele Tage vor der Löschung gewarnt wird — je Frist genau eine Mail. */
const WARN_DAYS = [14, 3] as const;
const WARN_ACTION: Record<(typeof WARN_DAYS)[number], AuditAction> = {
  14: AUDIT_ACTION.instancePurgeWarned14,
  3: AUDIT_ACTION.instancePurgeWarned3,
};

const ACTOR: Actor = { userId: null, name: 'purge' };
const SOURCE = { ip: null, userAgent: null };

export interface PurgeResult {
  warned: number;
  /** Vollständig gelöscht (Instanz und Organisation behandelt). */
  purged: number;
  /** Wartet auf die Bestätigung des Sicherungs-Agenten. */
  waiting: number;
  error: number;
}

/**
 * DIE LÖSCHUNG 90 TAGE NACH DER ARCHIVIERUNG (ändert R1/R4, bewusst und eng).
 *
 * Gelöscht wird alles ausser den Rechnungen. Reihenfolge, je Instanz:
 * 1. Warnmails an die Admins, 14 und 3 Tage vorher (je Frist einmal; der
 *    Nachweis ist ein Audit-Eintrag).
 * 2. Coolify: Anwendung samt Volumes. 404 = schon erledigt. Danach wird
 *    `coolifyApplicationId` geleert — das ist das Zeichen für den Plan, dass
 *    der Agent den Speicher leeren darf.
 * 3. Sicherungs-Agent: löscht `instances/<subdomain>/` und meldet `purged`
 *    (Audit-Eintrag). Ohne Sicherungsziel entfällt der Schritt.
 * 4. Erst danach, in EINER Transaktion: die Zeilen InstanceRestore, Backup,
 *    Metric, Instance, der Audit-Eintrag und die Organisation (ohne
 *    Rechnungen `completeDelete`, sonst `contactDataDelete`). Scheitert die
 *    Organisation, bleibt auch die Instanzzeile stehen, und die nächste Nacht
 *    wiederholt den Schritt.
 *
 * Gelöscht wird nur, wenn die Instanz seit 90 Tagen archiviert UND die
 * Organisation seit 90 Tagen `ended` ist (`expiredArchive`).
 * Schlägt ein Schritt fehl, bleibt der Rest stehen; die nächste Nacht setzt
 * dort fort (idempotent). Die Aufgabe „Löschung fehlgeschlagen" zeigt, was
 * über die Frist hinaus hängt. Läuft nur bei entsperrtem Tresor.
 */
@Injectable()
export class PurgeService {
  private readonly logger = new Logger(PurgeService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly vault: VaultService,
    private readonly mail: MailService,
    private readonly companies: CompanyService,
    @Inject(PROVISIONER) private readonly provisioner: Provisioner,
  ) {}

  private enabled(): boolean {
    return this.config.get<string>('CONTROL_PURGE_ENABLED', 'ja') !== 'nein';
  }

  /** Läuft die Löschung (Schalter an, Tresor entsperrt)? Nur dann nennt der Sicherungsplan `purge`. */
  isActive(): boolean {
    return this.enabled() && this.vault.isReady();
  }

  /** Täglich um 3:15 Uhr, nach dem Zeitplan. */
  @Cron('0 15 3 * * *', { name: 'instance-purge-daily' })
  async dailyRun(): Promise<void> {
    if (!this.enabled()) {
      this.logger.log('Die automatische Löschung ist abgeschaltet (CONTROL_PURGE_ENABLED=nein).');
      return;
    }
    if (!this.vault.isReady()) {
      this.logger.warn('Tresor gesperrt: die automatische Löschung wartet bis zum Entsperren.');
      return;
    }
    if (this.running) {
      this.logger.warn('Vorheriger Löschlauf ist noch nicht fertig.');
      return;
    }
    this.running = true;
    try {
      const result = await this.run();
      this.logger.log(
        `Löschlauf: ${result.warned} gewarnt, ${result.purged} gelöscht, ` +
          `${result.waiting} warten auf den Agenten, ${result.error} Fehler.`,
      );
    } catch (exception) {
      this.logger.error(`Löschlauf abgebrochen: ${exception instanceof Error ? exception.message : String(exception)}`);
    } finally {
      this.running = false;
    }
  }

  async run(): Promise<PurgeResult> {
    const result: PurgeResult = { warned: 0, purged: 0, waiting: 0, error: 0 };
    result.warned = await this.warn();

    const due = await this.prisma.instance.findMany({
      where: expiredArchive(),
      orderBy: { archivedAt: 'asc' },
      select: { id: true, subdomain: true },
    });
    for (const instance of due) {
      try {
        const outcome = await this.process(instance);
        if (outcome === 'purged') result.purged += 1;
        else result.waiting += 1;
      } catch (exception) {
        result.error += 1;
        await this.failed(instance, exception);
      }
    }
    return result;
  }

  /** Verschickt die fälligen Vorwarnungen; gibt die Zahl der Instanzen zurück, zu denen eine Mail hinausging. */
  private async warn(): Promise<number> {
    const day = today();
    const candidates = await this.prisma.instance.findMany({
      where: {
        status: 'archived',
        archivedAt: { lte: toDate(datePlusDays(day, -(PURGE_DAYS - WARN_DAYS[0]))) },
        // Dieselbe Bedingung wie die Löschung, nur 14 Tage früher.
        ...endedCompany(datePlusDays(day, WARN_DAYS[0])),
      },
      select: { id: true, subdomain: true, archivedAt: true, company: { select: { endedAt: true } } },
    });
    if (candidates.length === 0) return 0;
    const admins = await this.prisma.user.findMany({
      where: { accessRole: 'admin', emergency: false, deactivatedAt: null },
      select: { email: true },
    });

    let warned = 0;
    for (const instance of candidates) {
      // Ein Fehler bei einer Instanz (z. B. beim Audit-Eintrag) bricht weder den Lauf noch die Löschung ab.
      // Shortcut: scheitert nur der Audit-Eintrag nach dem Versand, geht die Mail nächste Nacht erneut hinaus.
      try {
        if (await this.warnOne(instance, admins, day)) warned += 1;
      } catch (exception) {
        this.logger.error(
          `Warnung für ${instance.subdomain} fehlgeschlagen: ${exception instanceof Error ? exception.message : String(exception)}`,
        );
      }
    }
    return warned;
  }

  /** Eine Vorwarnung; `true`, wenn mindestens eine Mail hinausging und der Nachweis steht. */
  private async warnOne(
    instance: { id: string; subdomain: string; archivedAt: Date | null; company: { endedAt: Date | null } },
    admins: { email: string }[],
    day: string,
  ): Promise<boolean> {
    // Gelöscht wird, wenn beide Fristen um sind: die spätere zählt.
    const purgeOn = [instance.archivedAt as Date, instance.company.endedAt as Date]
      .map((date) => deletionDay(dateStringFromDate(date)))
      .sort()
      .pop() as string;
    const daysLeft = Math.round((toDate(purgeOn).getTime() - toDate(day).getTime()) / 86_400_000);
    if (daysLeft < 1) return false; // schon fällig: die Löschung läuft ohnehin.
    // Die engste Frist, die erreicht ist; wer erst nach der 14-Tage-Marke eingeholt wird, bekommt nur die nächste Mail.
    const threshold = [...WARN_DAYS].reverse().find((n) => daysLeft <= n);
    if (threshold === undefined) return false;
    const done = await this.prisma.auditLog.count({
      where: { action: WARN_ACTION[threshold], objectId: instance.id },
    });
    if (done > 0) return false;
    let sent = 0;
    for (const { email } of admins) {
      try {
        await this.mail.sendPurgeWarning(email, instance.subdomain, dayReadable(purgeOn), daysLeft);
        sent += 1;
      } catch {
        // `MailService` hat den Grund schon protokolliert.
      }
    }
    // Ohne eine einzige zugestellte Mail kein Nachweis: die nächste Nacht versucht es erneut.
    if (sent === 0) return false;
    await this.audit.log({
      userId: null,
      actor: ACTOR.name,
      action: WARN_ACTION[threshold],
      objectType: 'Instance',
      objectId: instance.id,
      afterValue: { subdomain: instance.subdomain, purgeOn, recipients: sent },
    });
    return true;
  }

  private async process(due: { id: string }): Promise<'purged' | 'waiting'> {
    // Neu lesen: zwischen Auswahl und Schritt kann die Instanz übernommen oder die Organisation wieder geöffnet worden sein.
    const instance = await this.prisma.instance.findFirst({
      where: { id: due.id, ...expiredArchive() },
      select: { id: true, companyId: true, subdomain: true, coolifyApplicationId: true },
    });
    if (instance === null) return 'waiting';

    // 1) Coolify
    if (instance.coolifyApplicationId !== null) {
      await this.provisioner.deleteApplication(instance.coolifyApplicationId, true);
      const cleared = await this.prisma.instance.updateMany({
        where: { id: instance.id, ...expiredArchive(), coolifyApplicationId: instance.coolifyApplicationId },
        data: { coolifyApplicationId: null },
      });
      if (cleared.count !== 1) throw new Error('Die Instanz hat sich während der Löschung geändert.');
      await this.audit.log({
        userId: null,
        actor: ACTOR.name,
        action: AUDIT_ACTION.instanceCoolifyDeleted,
        objectType: 'Instance',
        objectId: instance.id,
        afterValue: { subdomain: instance.subdomain },
      });
    }

    // 2) Sicherungsziel: der Agent löscht beim nächsten Lauf und meldet es zurück.
    if ((await this.prisma.backupTarget.count()) > 0) {
      const confirmed = await this.prisma.auditLog.count({
        where: { action: AUDIT_ACTION.instanceStoragePurged, objectId: instance.id },
      });
      if (confirmed === 0) return 'waiting';
    }

    // 3) Zeilen, Audit-Eintrag und Organisation in EINER Transaktion, in Restrict-Reihenfolge.
    // Scheitert etwas (auch die Organisation), bleibt alles stehen und die nächste Nacht wiederholt es.
    await this.prisma.$transaction(
      async (tx) => {
        // Organisation sperren und erst dann die Frist prüfen: ein Neustart (status-change) wartet auf dieselbe Zeile.
        await tx.$queryRaw`SELECT "id" FROM "Company" WHERE "id" = ${instance.companyId} FOR UPDATE`;
        const stillEnded = await tx.instance.count({ where: { id: instance.id, ...expiredArchive() } });
        if (stillEnded !== 1) throw new Error('Die Organisation ist nicht mehr beendet oder die Frist läuft neu.');
        const restores = await tx.instanceRestore.deleteMany({ where: { instanceId: instance.id } });
        const backups = await tx.backup.deleteMany({ where: { instanceId: instance.id } });
        const metrics = await tx.metric.deleteMany({ where: { instanceId: instance.id } });
        // Bedingt und gezählt: nur die noch fällige, archivierte Instanz einer beendeten Organisation.
        const gone = await tx.instance.deleteMany({ where: { id: instance.id, ...expiredArchiveCoolifyGone() } });
        if (gone.count !== 1) throw new Error('Die Instanz hat sich während der Löschung geändert.');
        await this.audit.log(
          {
            userId: null,
            actor: ACTOR.name,
            action: AUDIT_ACTION.instancePurged,
            objectType: 'Instance',
            objectId: instance.id,
            afterValue: {
              subdomain: instance.subdomain,
              restores: restores.count,
              backups: backups.count,
              metrics: metrics.count,
            },
          },
          tx,
        );
        await this.dispose(tx, instance.companyId);
      },
      { timeout: 120_000 },
    );
    return 'purged';
  }

  /** Organisation. Mit Rechnungen bleibt die Hülle (GoBD), ohne wird sie entfernt. Der Name wird in der Transaktion gelesen. */
  private async dispose(tx: Prisma.TransactionClient, companyId: string): Promise<void> {
    const company = await tx.company.findUnique({ where: { id: companyId }, select: { name: true } });
    if (company === null) return;
    const invoices = await tx.invoice.count({ where: { companyId } });
    if (invoices === 0) {
      try {
        await this.companies.completeDelete(companyId, company.name, ACTOR, SOURCE, tx);
        return;
      } catch (exception) {
        // Werbliche Mails sperren die Komplettlöschung (R3): dann die Hülle behalten und anonymisieren.
        if (!(exception instanceof CompanyNotDeletableError)) throw exception;
      }
    }
    await this.companies.contactDataDelete(companyId, company.name, ACTOR, SOURCE, tx);
  }

  private async failed(instance: { id: string; subdomain: string }, exception: unknown): Promise<void> {
    const reason = exception instanceof Error ? exception.message : String(exception);
    this.logger.error(`Löschung von ${instance.subdomain} fehlgeschlagen: ${reason}`);
    await this.audit
      .log({
        userId: null,
        actor: ACTOR.name,
        action: AUDIT_ACTION.instancePurgeFailed,
        objectType: 'Instance',
        objectId: instance.id,
        afterValue: { subdomain: instance.subdomain, reason: reason.slice(0, 300) },
      })
      .catch(() => undefined);
  }
}
