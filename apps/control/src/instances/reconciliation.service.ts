import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { Prisma } from '.prisma/control-client';
import { dateStringFromDate, today } from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import { CoolifyConfigService, PRESETS, instanceHost } from '../coolify/coolify.config';
import { PROVISIONER, type Provisioner } from '../provisioning/provisioner';
import { PrismaService } from '../prisma/prisma.service';
import type { ReconciliationDeviation, OrphanedApplication } from './instance.types';

export interface ReconciliationResult {
  successful: boolean;
  message: string | null;
  orphanedApplications: OrphanedApplication[];
  deviations: ReconciliationDeviation[];
}

/** Coolify-Zustände, die wir als „läuft" lesen. */
const RUNNING = ['running', 'running:healthy', 'degraded'];

/**
 * DER TÄGLICHE ABGLEICH — ER MELDET, ER KORRIGIERT NICHT (E3-16).
 *
 * Dieselbe Zurückhaltung, mit der das Aufgabenmodul aus Etappe 2 nie schreibend
 * eingreift, und derselbe Grund: Eine automatische Korrektur zwischen zwei
 * Systemen, die auseinandergelaufen sind, weiss nicht, WELCHES von beiden
 * recht hat. Sie würde im schlimmsten Fall die richtige Seite an die falsche
 * angleichen — und niemand sähe es.
 *
 * Der Lauf schreibt deshalb ausschliesslich in die EIGENE Datenbank
 * (`AbgleichLauf`) und ändert weder eine Instanz noch irgendetwas in Coolify.
 *
 * DREI ARTEN VON BEFUND:
 * 1. CRM-Eintrag ohne Coolify-Anwendung  → Aufgabe (organisationsgebunden)
 * 2. Statusunterschied CRM ↔ Coolify     → Aufgabe (organisationsgebunden)
 * 3. Coolify-Anwendung ohne CRM-Eintrag  → eigene Liste (keine Organisation)
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly coolifyConfig: CoolifyConfigService,
    @Inject(PROVISIONER) private readonly provisioner: Provisioner,
  ) {}

  /** Täglich um 4:30 Uhr — nach dem Kennzahlen-Abruf. */
  @Cron('0 30 4 * * *', { name: 'coolify-reconciliation' })
  async dailyRun(): Promise<void> {
    if (this.config.get<string>('CONTROL_RECONCILIATION_ENABLED', 'ja') === 'nein') {
      this.logger.log('Der Coolify-Abgleich ist abgeschaltet.');
      return;
    }
    if (this.running) {
      this.logger.warn('Vorheriger Abgleich ist noch nicht fertig.');
      return;
    }
    this.running = true;
    try {
      await this.executeFrom({ actor: 'coolify-reconciliation', userId: null });
    } finally {
      this.running = false;
    }
  }

  async executeFrom(trigger: {
    actor: string;
    userId: string | null;
  }): Promise<ReconciliationResult> {
    const set = this.coolifyConfig.read();
    const contract = this.coolifyConfig.contract();
    const prefix = `${contract.instancePrefix}-`;
    const own = new Set(
      set?.ownApplications ?? PRESETS.ownApplications,
    );
    const todayDay = today();

    let applications;
    try {
      applications = await this.provisioner.status();
    } catch (exception) {
      // EIN GESCHEITERTER LAUF IST KEIN LEERER BEFUND. Ohne `erfolgreich:
      // false` läse die Oberfläche „keine Abweichungen" — die beruhigendste
      // aller falschen Auskünfte.
      const reason = exception instanceof Error ? exception.message : String(exception);
      const result: ReconciliationResult = {
        successful: false,
        message: `Coolify war nicht erreichbar: ${reason}`,
        orphanedApplications: [],
        deviations: [],
      };
      await this.store(result, trigger);
      return result;
    }

    const instances = await this.prisma.instance.findMany({
      where: { status: { in: ['provisioning', 'active', 'stopped'] } },
      select: {
        id: true,
        companyId: true,
        subdomain: true,
        status: true,
        coolifyApplicationId: true,
      },
    });

    const byUuid = new Map(applications.map((a) => [a.ref, a]));
    const byDomain = new Map<string, (typeof applications)[number]>();
    for (const application of applications) {
      for (const domain of application.domains) byDomain.set(domain, application);
    }

    const deviations: ReconciliationDeviation[] = [];
    const assigned = new Set<string>();

    for (const instance of instances) {
      const fqdn = instanceHost(contract, instance.subdomain);
      const found =
        (instance.coolifyApplicationId !== null
          ? byUuid.get(instance.coolifyApplicationId)
          : undefined) ?? byDomain.get(fqdn);

      if (found === undefined) {
        // Eine Instanz, die gerade erst angelegt wird, ist in Coolify
        // vielleicht noch nicht sichtbar — das ist kein Befund, sondern der
        // Normalfall der ersten Minuten.
        if (instance.status === 'provisioning') continue;
        deviations.push({
          instanceId: instance.id,
          companyId: instance.companyId,
          kind: 'without_coolify_application',
          crmStatus: instance.status,
          coolifyStatus: null,
        });
        continue;
      }

      assigned.add(found.ref);
      const runningThere = RUNNING.some((z) => found.status.startsWith(z));
      const shouldRun = instance.status === 'active';
      if (runningThere !== shouldRun) {
        deviations.push({
          instanceId: instance.id,
          companyId: instance.companyId,
          kind: 'statusunterschied',
          crmStatus: instance.status,
          coolifyStatus: found.status,
        });
      }
    }

    // Verwaiste: Coolify-Anwendungen unseres Namensschemas, die zu keiner
    // Instanz gehören. Fremde Anwendungen im selben Projekt bleiben aussen vor
    // — sie zu melden wäre Rauschen, kein Befund.
    //
    // DIE EIGENEN DEPLOYMENTS EBENFALLS ([bugfix 07.09.2026]). `GET
    // /applications` liefert ALLES, was in Coolify liegt: die Verwaltung
    // selbst, die Webseite, die Kunden-App. Sie heissen nach demselben
    // Schema wie eine Kundeninstanz und standen deshalb dauerhaft als
    // „verwaist" unter „Heute" — vier Befunde, die immer dastanden.
    //
    // Vier Falschmeldungen machen aus dieser Liste eine, die niemand mehr
    // liest, und dann rutscht der eine echte Fund durch, für den es sie
    // gibt: eine Kundeninstanz, die in Coolify läuft und die niemand ins CRM
    // eingetragen hat.
    //
    // SIE KANN KEINE KUNDENINSTANZ VERDECKEN. `InstanceService.isTaken`
    // prüft eine gewünschte Subdomain unter anderem gegen
    // `<präfix>-<subdomain>` in Coolify — die Subdomains dieser Liste sind
    // damit strukturell vergeben, es kann sie gar keine Kundeninstanz geben.
    const knownSubdomains = new Set(instances.map((i) => i.subdomain));
    const candidates = applications
      .filter((a) => !assigned.has(a.ref))
      .filter((a) => a.name.startsWith(prefix));
    const hidden = candidates.filter((a) => own.has(a.name)).length;
    const orphaned: OrphanedApplication[] = candidates
      .filter((a) => !own.has(a.name))
      .map((a) => ({
        subdomain: a.name.slice(prefix.length),
        coolifyUrl: a.domains[0] ? `https://${a.domains[0]}` : null,
        detectedAt: todayDay,
      }))
      .filter((a) => !knownSubdomains.has(a.subdomain));

    const result: ReconciliationResult = {
      successful: true,
      message: null,
      orphanedApplications: await this.withFirstFinding(orphaned),
      deviations,
    };
    await this.store(result, trigger);
    // DIE ZAHL DER AUSGEBLENDETEN STEHT IM LOG, bei jedem Lauf. Ein Filter,
    // von dem niemand weiss, wäre schlimmer als die Falschmeldung, die er
    // behebt: Dann fehlte ein Befund, und man suchte ihn nicht einmal.
    this.logger.log(
      `Abgleich: ${deviations.length} Abweichungen, ` +
        `${orphaned.length} verwaiste Anwendungen` +
        (hidden === 0
          ? '.'
          : `, ${hidden} eigene Anwendung(en) ausgeblendet ` +
            `(CONTROL_COOLIFY_OWN_APPLICATIONS).`),
    );
    return result;
  }

  /**
   * Setzt `detectedAt` auf den TAG DES ERSTEN Befunds, nicht auf heute.
   *
   * Die Oberfläche schreibt „Seit <Datum>". Stünde dort jeden Tag das
   * Tagesdatum, wäre jede Waise immer „seit heute" — und man sähe nie, dass
   * eine seit sechs Wochen dasteht.
   */
  private async withFirstFinding(
    orphaned: OrphanedApplication[],
  ): Promise<OrphanedApplication[]> {
    if (orphaned.length === 0) return [];
    const before = await this.lastRun();
    const earlier = new Map(
      (before?.orphanedApplications ?? []).map((a) => [a.subdomain, a.detectedAt]),
    );
    return orphaned.map((a) => ({
      ...a,
      detectedAt: earlier.get(a.subdomain) ?? a.detectedAt,
    }));
  }

  /** Der jeweils letzte Lauf — das ist der Stand, den die Oberfläche zeigt. */
  async lastRun(): Promise<ReconciliationResult | null> {
    const row = await this.prisma.reconciliationRun.findFirst({
      orderBy: { executedAt: 'desc' },
    });
    if (row === null) return null;
    return {
      successful: row.successful,
      message: row.message,
      orphanedApplications: asOrphaned(row.orphanedApplications),
      deviations: asDeviations(row.deviations),
    };
  }

  private async store(
    result: ReconciliationResult,
    trigger: { actor: string; userId: string | null },
  ): Promise<void> {
    await this.prisma.reconciliationRun.create({
      data: {
        successful: result.successful,
        message: result.message,
        orphanedApplications:
          result.orphanedApplications as unknown as Prisma.InputJsonValue,
        deviations: result.deviations as unknown as Prisma.InputJsonValue,
      },
    });
    await this.audit.log({
      userId: trigger.userId,
      actor: trigger.actor,
      action: AUDIT_ACTION.coolifyReconciliation,
      objectType: 'ReconciliationRun',
      objectId: null,
      afterValue: {
        successful: result.successful,
        deviations: result.deviations.length,
        orphaned: result.orphanedApplications.length,
      },
    });
  }
}

function asOrphaned(value: unknown): OrphanedApplication[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e): e is OrphanedApplication =>
      typeof e === 'object' &&
      e !== null &&
      typeof (e as OrphanedApplication).subdomain === 'string',
  );
}

function asDeviations(value: unknown): ReconciliationDeviation[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e): e is ReconciliationDeviation =>
      typeof e === 'object' &&
      e !== null &&
      typeof (e as ReconciliationDeviation).instanceId === 'string',
  );
}

/** `YYYY-MM-DD` aus einem Zeitstempel — für Anzeigen, die nur den Tag wollen. */
export function dayFrom(timestamp: Date): string {
  return dateStringFromDate(
    new Date(
      Date.UTC(
        timestamp.getUTCFullYear(),
        timestamp.getUTCMonth(),
        timestamp.getUTCDate(),
      ),
    ),
  );
}
