import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  datePlusDays,
  dateStringFromDate,
  today,
  toDate,
} from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import { CoolifyConfigService, instanceHost } from '../coolify/coolify.config';
import {
  PROVISIONER,
  ProvisioningFailedError,
  WAIT,
  realWait,
  type Provisioner,
  type Wait,
} from '../provisioning/provisioner';
import { buildInstanceEnvironment } from './instance-environment';
import { writeSystemNote } from '../notes/system-note';
import { PrismaService } from '../prisma/prisma.service';
import { HEALTH_TIMEOUT_S, BACKUP_MISSING_AFTER_DAYS } from './instance.rules';

export { WAIT, realWait };
export type { Wait };

/** Wie oft der Health-Check versucht wird (Millisekunden). */
export const HEALTH_INTERVAL_MS = 5_000;
/**
 * Präfix der Meldung, wenn das Deployment durch ist, die Instanz aber noch
 * nicht antwortet — KEIN Fehlschlag.
 *
 * Meist fehlt nur das TLS-Zertifikat. Hier stand bis zum 11.09.2026 ein
 * Fehlschlag, und das war eine Sackgasse: Die Instanz lief, blieb aber für
 * immer auf `wird_erstellt`, weil nur der Aufbau selbst sie auf `aktiv` setzt.
 * Verwerfen ging nicht, weil in Coolify eine Anwendung stand. Das
 * Provisionierungsskript behandelte denselben Fall immer nur als Warnung.
 *
 * Die Karte erkennt den Zustand an diesem Präfix und bietet „Erneut prüfen"
 * an — ein reiner Lesezugriff auf die Instanz, kein Schreibvorgang gegen
 * Coolify (R1).
 */
export const REACHABILITY_PENDING = 'Erreichbarkeit ausstehend: ';

/**
 * Ein einzelner Health-Check gegen die frische Instanz.
 *
 * Auswechselbar, damit Prüfläufe nicht ins Netz greifen — sonst hinge der
 * Aufbau in jedem Test die volle Zeitgrenze lang an einem Hostnamen, den es
 * nicht gibt.
 */
export type HealthCheck = (fqdn: string, path?: string) => Promise<boolean>;

/** Injektionsmarke der Gesundheitsprüfung. */
export const HEALTH_CHECK = 'HEALTH_CHECK';

export const realHealthCheck: HealthCheck = async (fqdn, path = '/api/health') => {
  const abort = new AbortController();
  const clock = setTimeout(() => abort.abort(), 5_000);
  try {
    const response = await fetch(`https://${fqdn}${path}`, {
      signal: abort.signal,
    });
    return response.ok;
  } catch {
    // Noch nicht da — TLS und Start brauchen einen Moment.
    return false;
  } finally {
    clearTimeout(clock);
  }
};

/**
 * DER LANG LAUFENDE TEIL — ausserhalb der HTTP-Anfrage.
 *
 * Warum getrennt: Coolify braucht laut Provisionierungsskript Minuten, nicht
 * Sekunden. Eine Anfrage, die so lange offen bliebe, beantwortete „was, wenn
 * ich die Seite verlasse" gar nicht erst. Stattdessen führt dieser Dienst den
 * Vorgang im Hintergrund und schreibt jeden Zwischenstand nach
 * `Instanz.meldung` — die Oberfläche holt sich den serverseitigen Stand und
 * braucht keinen eigenen Speicher.
 *
 * KEIN STILLER HALBZUSTAND (E3-12): Jeder Abbruch landet als Klartext in
 * `meldung` und als Zeile im Audit-Log. Es gibt bewusst KEINEN automatischen
 * zweiten Versuch — das wäre eine dritte Schreiboperation gegen Coolify, die
 * R1 nicht kennt, und sie liefe ohne Bestätigung eines Menschen.
 */
@Injectable()
export class InstanceProvisioningService {
  private readonly logger = new Logger(InstanceProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly coolifyConfig: CoolifyConfigService,
    @Inject(PROVISIONER) private readonly provisioner: Provisioner,
    // Beide über eine Marke, nicht über einen Vorgabewert — siehe `Warten`.
    // Die Reihenfolge bleibt, damit Prüfläufe den Dienst weiterhin mit `new`
    // bauen können; injiziert wird er im Betrieb über `InstanceModule`.
    @Inject(WAIT) private readonly wait: Wait,
    @Inject(HEALTH_CHECK)
    private readonly checkHealth: HealthCheck,
  ) {}

  private hostFor(subdomain: string): string {
    return instanceHost(this.coolifyConfig.contract(), subdomain);
  }

  private applicationName(subdomain: string): string {
    return `${this.coolifyConfig.contract().instancePrefix}-${subdomain}`;
  }

  /**
   * Legt die Instanz über den Provisioner an und wartet auf den Health-Check.
   * Danach steht die Instanz auf `aktiv`.
   *
   * Was der Anbieter dabei im Einzelnen tut (anlegen, Umgebung, Domäne,
   * ausrollen), weiss nur er; diese Methode kennt `create` und die
   * Rückmeldungen `onCreated` / `onProgress`.
   */
  async executeFrom(
    instanceId: string,
    subdomain: string,
    secrets: { metricsToken: string; setupToken: string },
  ): Promise<void> {
    const host = this.hostFor(subdomain);
    try {
      // GENAU EINMAL erzeugt. Ein zweiter Aufruf lieferte andere Zufallswerte —
      // dann stünde in der Anwendung ein anderes Datenbankpasswort als in den
      // Umgebungsvariablen, und die Instanz käme nie hoch.
      const environment = buildInstanceEnvironment({
        host,
        subdomain,
        smtp: this.coolifyConfig.read()?.instanceSmtp ?? null,
        secrets,
        templates: this.coolifyConfig.instanceEnvTemplates(),
      });

      await this.provisioner.create(
        { name: this.applicationName(subdomain), host, environment },
        {
          onProgress: (text) => this.report(instanceId, text),
          onCreated: async (ref) => {
            await this.prisma.instance.update({
              where: { id: instanceId },
              data: { coolifyApplicationId: ref },
            });
          },
        },
      );

      await this.report(instanceId, 'Warte auf Health-Check …');
      const healthy = await this.waitOnHealth(host);
      if (!healthy) {
        await this.fail(
          instanceId,
          `${REACHABILITY_PENDING}Das Deployment ist durchgelaufen, ` +
            `aber https://${host}${this.coolifyConfig.contract().healthPath} antwortet noch nicht. Meist ` +
            'fehlt nur das TLS-Zertifikat — „Erneut prüfen" fragt noch einmal.',
        );
        return;
      }

      await this.reportReady(instanceId, subdomain, host, {
        name: 'instanz-aufbau',
        userId: null,
      });
    } catch (exception) {
      if (exception instanceof ProvisioningFailedError) {
        // Der Anbieter hat den fertigen Klartext geliefert.
        await this.fail(instanceId, exception.message);
        return;
      }
      const reason = exception instanceof Error ? exception.message : String(exception);
      await this.fail(
        instanceId,
        `Fehlgeschlagen: ${reason}. Es wurde nichts gelöscht; bitte in Coolify ` +
          'nachsehen.',
      );
    }
  }

  /**
   * Setzt die Instanz auf `aktiv` — nach dem Aufbau ODER nach „Erneut prüfen".
   *
   * EINE Stelle für beide Wege, damit die Bedingung (nur aus `wird_erstellt`)
   * und der Nachweis nicht auseinanderlaufen.
   */
  private async reportReady(
    instanceId: string,
    subdomain: string,
    fqdn: string,
    actor: { name: string; userId: string | null },
  ): Promise<void> {
    // =================================================================
    // NUR FERTIGMELDEN, WENN DIE INSTANZ NOCH IM AUFBAU IST
    // =================================================================
    //
    // DER FEHLER, DER DAS AUSGELÖST HAT: Hier stand ein bedingungsloses
    // `update`. Wer eine gerade entstehende Instanz archivierte — zwei
    // Klicks, während dieser Lauf noch arbeitete —, bekam sie danach
    // wieder als `aktiv` zurück: Der Aufbau überschrieb den Zustand, den
    // er nicht gesetzt hatte. In Coolify war der Container gestoppt, im
    // CRM stand „aktiv". Ein stiller Widerspruch zwischen Anzeige und
    // Wirklichkeit.
    //
    // Aufgefallen ist es dem Integrationstest „stoppt bei zwei
    // GLEICHZEITIGEN Archivierungen nur einmal in Coolify", der etwa jeden
    // zehnten Lauf rot wurde. Die erste Vermutung — ein Rennen zwischen
    // den beiden Archivierungen — war falsch; der bedingte Schreibvorgang
    // dort hat immer gehalten. Der dritte Schreiber war dieser hier.
    //
    // `updateMany` mit Bedingung statt `update`: Trifft es keine Zeile,
    // hat jemand anderes den Zustand inzwischen bestimmt, und das ist in
    // Ordnung — der Aufbau ist trotzdem durchgelaufen und hat seine
    // Audit-Zeile verdient.
    const adopted = await this.prisma.instance.updateMany({
      where: { id: instanceId, status: 'provisioning' },
      data: { status: 'active', message: null },
    });
    if (adopted.count === 0) {
      this.logger.warn(
        `Instanz ${instanceId}: Aufbau fertig, aber der Zustand wurde ` +
          'zwischenzeitlich von anderer Stelle gesetzt (etwa durch eine ' +
          'Archivierung). Der Aufbau meldet NICHT „aktiv" — sonst machte ' +
          'er die Archivierung stillschweigend rückgängig.',
      );
    }
    await this.audit.log({
      userId: actor.userId,
      actor: actor.name,
      action: AUDIT_ACTION.instanceReady,
      objectType: 'Instance',
      objectId: instanceId,
      afterValue: { subdomain, status: 'active' },
    });
    this.logger.log(`Instanz ${fqdn} ist bereit.`);
  }

  /**
   * „Erneut prüfen": fragt EINMAL, ob die Instanz jetzt antwortet, und setzt
   * sie dann auf `aktiv`.
   *
   * NUR LESEND gegen die Instanz und GAR NICHT gegen Coolify — deshalb keine
   * dritte Schreiboperation (R1) und kein Widerspruch zu „kein Erneut
   * versuchen": Jene Regel gilt dem Wiederholen von Schreibvorgängen. Ob der
   * Zustand diese Prüfung überhaupt erlaubt, entscheidet `InstanceService`.
   */
  async checkReachability(
    instanceId: string,
    subdomain: string,
    actor: { name: string; userId: string | null },
  ): Promise<boolean> {
    const fqdn = this.hostFor(subdomain);
    if (!(await this.checkHealth(fqdn, this.coolifyConfig.contract().healthPath))) return false;
    await this.reportReady(instanceId, subdomain, fqdn, actor);
    return true;
  }

  /**
   * Stoppt die Anwendung, löst eine letzte Sicherung aus und setzt den Status.
   *
   * NIEMALS LÖSCHEN. Scheitert das Stoppen, bleibt die Instanz auf `gestoppt`
   * stehen und die `meldung` nennt den Grund — auch das ist ein sichtbarer
   * Zustand und kein Halbzustand.
   */
  async executeArchivingFrom(instanceId: string): Promise<void> {
    const instance = await this.prisma.instance.findUnique({
      where: { id: instanceId },
      select: {
        id: true,
        companyId: true,
        subdomain: true,
        coolifyApplicationId: true,
        backups: { orderBy: { date: 'desc' }, take: 1, select: { date: true } },
      },
    });
    if (instance === null) return;

    const hints: string[] = [];
    try {
      if (instance.coolifyApplicationId === null) {
        hints.push(
          'In Coolify ist zu dieser Instanz keine Anwendung hinterlegt — es ' +
            'wurde nichts gestoppt. Bitte von Hand prüfen.',
        );
      } else {
        await this.report(instanceId, 'Die Instanz wird gestoppt …');
        await this.provisioner.stop(instance.coolifyApplicationId);
      }

      // DER SICHERUNGSSTAND WIRD GENANNT, NICHT BEHAUPTET ([W2]).
      //
      // Eine frühere Fassung rief hier `loeseSicherungAus` gegen einen
      // Coolify-Endpunkt, den es in dieser Betriebsform nicht gibt: Die
      // Datenbank einer Instanz liegt in deren Compose-Stapel und ist keine
      // eigene Coolify-Ressource, die zugehörige UUID wurde nie befüllt. Der
      // Aufruf war toter Code und zugleich der einzige erfundene Beleg in der
      // ganzen Anbindung.
      //
      // Stattdessen steht hier, WIE ES WIRKLICH IST — und wenn die letzte
      // Sicherung zu alt ist, steht das als Handlungsaufforderung im Verlauf.
      // Eine archivierte Instanz meldet sich nicht mehr über die
      // Dashboard-Aufgabe, deshalb muss es an dieser Stelle stehen.
      hints.push(this.backupState(instance.backups[0]?.date ?? null));

      const hint = hints.join(' ');
      // DIESELBE BEDINGUNG WIE BEIM AUFBAU, aus demselben Grund: Dieser Lauf
      // hat die Instanz auf `gestoppt` vorgefunden und schreibt nur dann
      // weiter, wenn sie es noch ist. Ein bedingungsloses `update` machte
      // sonst aus jedem zwischenzeitlichen Zustand ein „archiviert".
      await this.prisma.instance.updateMany({
        where: { id: instanceId, status: 'stopped' },
        data: {
          status: 'archived',
          archivedAt: toDate(today()),
          message: hint,
        },
      });
      await this.audit.log({
        userId: null,
        actor: 'instanz-aufbau',
        action: AUDIT_ACTION.instanceArchived,
        objectType: 'Instance',
        objectId: instanceId,
        afterValue: {
          subdomain: instance.subdomain,
          status: 'archived',
          hint,
        },
      });

      // DER VERLAUF IST DIE STELLE, AN DER JEMAND WOCHEN SPÄTER NACHSIEHT.
      //
      // Die Instanz-Karte zeigt im archivierten Zustand nur noch die
      // Stammdaten; ein Hinweis, der ausschliesslich in `meldung` stünde, wäre
      // dort unsichtbar — genau der stille Halbzustand, den E3-12
      // ausschliesst. Die Systemnotiz steht dauerhaft im Verlauf der
      // Organisation und ist unveränderlich.
      await writeSystemNote(
        this.prisma,
        instance.companyId,
        [
          `Instanz ${instance.subdomain} archiviert: gestoppt, Status auf ` +
            '„Archiviert" gesetzt. Es wurde nichts gelöscht — die Daten ' +
            'bleiben erhalten. Wiederherstellung von Hand in Coolify.',
          hint,
        ]
          .filter((part): part is string => part !== null && part.length > 0)
          .join(' '),
      );
    } catch (exception) {
      const reason = exception instanceof Error ? exception.message : String(exception);
      await this.fail(
        instanceId,
        `Fehlgeschlagen: ${reason}. Es wurde nichts gelöscht; die Instanz ` +
          'steht weiterhin in Coolify.',
      );
    }
  }

  /**
   * Sagt, wie es um die letzte Sicherung steht — als Klartext für den Verlauf.
   *
   * Die Archivierung LÖST KEINE Sicherung aus (siehe oben). Sie sagt, was da
   * ist, und benennt den Handgriff, wenn es nicht reicht. Das ist die ehrliche
   * Fassung von „letzten Dump ziehen": Was dieses System nicht selbst tun
   * kann, behauptet es auch nicht.
   */
  private backupState(last: Date | null): string {
    if (last === null) {
      return (
        'ACHTUNG: Für diese Instanz ist nie eine Sicherung gemeldet worden. ' +
        'Bitte VOR dem Aufräumen in Coolify eine Sicherung ziehen und extern ' +
        'ablegen — die Daten bleiben bis dahin im gestoppten Container.'
      );
    }
    const day = dateStringFromDate(last);
    if (day >= datePlusDays(today(), -BACKUP_MISSING_AFTER_DAYS)) {
      return `Letzte Sicherung: ${day}.`;
    }
    return (
      `ACHTUNG: Die letzte Sicherung stammt vom ${day} und ist damit nicht ` +
      'mehr aktuell. Bitte in Coolify eine abschliessende Sicherung ziehen — ' +
      'die Daten bleiben bis dahin im gestoppten Container.'
    );
  }

  /** Fragt den Health-Endpunkt der frischen Instanz, bis er antwortet. */
  private async waitOnHealth(fqdn: string): Promise<boolean> {
    // FESTE VERSUCHSZAHL statt Uhrzeit. Gegen `Date.now()` gerechnet drehte
    // die Schleife in Tests mit ausgeschalteter Wartefunktion 180 Sekunden
    // leer; so ist sie dort sofort durch. Im Betrieb dauert es gleich lang
    // oder etwas länger (jeder Versuch hat eigene 5 s Zeitgrenze) — für ein
    // Zertifikat, das noch unterwegs ist, eher ein Vorteil.
    const attempts = Math.ceil((HEALTH_TIMEOUT_S * 1000) / HEALTH_INTERVAL_MS);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await this.checkHealth(fqdn, this.coolifyConfig.contract().healthPath)) return true;
      await this.wait(HEALTH_INTERVAL_MS);
    }
    return false;
  }

  private async report(instanceId: string, text: string): Promise<void> {
    await this.prisma.instance.update({
      where: { id: instanceId },
      data: { message: text },
    });
  }

  /**
   * Hält das Scheitern fest — sichtbar in der Karte und im Nachweis.
   *
   * Der Status bleibt bewusst, wie er ist (`wird_erstellt` bzw. `gestoppt`):
   * Ein eigener `fehlgeschlagen`-Enumwert wäre eine Schemaänderung, die der
   * Datenvertrag der Oberfläche nicht kennt (Offener Punkt 12.1). Die Meldung
   * trägt die Aussage vollständig, und die Karte zeigt sie in beiden
   * Zuständen an.
   */
  private async fail(instanceId: string, text: string): Promise<void> {
    this.logger.error(`Instanz ${instanceId}: ${text}`);
    await this.prisma.instance.update({
      where: { id: instanceId },
      data: { message: text },
    });
    await this.audit.log({
      userId: null,
      actor: 'instanz-aufbau',
      action: AUDIT_ACTION.instanceProvisioningError,
      objectType: 'Instance',
      objectId: instanceId,
      afterValue: { message: text },
    });
  }
}
