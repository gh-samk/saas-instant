import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { dateStringFromDate, today, toDate } from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import type { InquirySource } from '../common/inquiry-source';
import { CoolifyConfigService, instanceHost } from '../coolify/coolify.config';
import {
  normalizeSubdomain,
  subdomainError,
  subdomainSuggestion,
} from '../coolify/subdomain';
import { PROVISIONER, type Provisioner } from '../provisioning/provisioner';
import { CryptoService } from '../crypto/crypto.service';
import { CompanyNotFoundError } from '../companies/company.errors';
import { writeSystemNote } from '../notes/system-note';
import { PrismaService } from '../prisma/prisma.service';
import { REACHABILITY_PENDING, InstanceProvisioningService } from './instance-provisioning.service';
import { invitationLinkFrom, toInstanceDetail, toMetrics } from './instance.response';
import {
  InstanceExistsAlreadyError,
  InstanceNotFoundError,
  InstanceStatusMismatchError,
  InstanceSendMissingError,
  ReachabilityNotCheckableError,
  SubdomainInvalidError,
  SubdomainTakenError,
  DiscardNotPossibleError,
} from './instance.errors';
import { consumePreview } from './instance.preview';
import type { InstanceListenEntry } from './instance.types';
import {
  DATABASE_NAME,
  ENVIRONMENT_VARIABLES,
  PREVIEW_VALID_MINUTES,
} from './instance.rules';
import type { InstanceDetail, InstancePreviewResponse,
  InstanceStatus,
} from './instance.types';

/** Wer die Handlung ausgelöst hat. */
export interface Actor {
  userId: string | null;
  name: string;
}

/**
 * Die Instanzverwaltung des CRM.
 *
 * HARTE REGEL R1, die alles hier bestimmt: Es gibt KEINE SQL-Verbindung zu
 * Kundendatenbanken. Auf einer Kundeninstanz existieren genau ZWEI
 * Schreibvorgänge — anlegen und stoppen/archivieren —, beide über die
 * Coolify-API und beide nur nach ausdrücklicher Bestätigung. Kein Löschen,
 * kein Wiederherstellen, kein „erneut versuchen" als dritte Schreiboperation.
 *
 * DREI MASSNAHMEN GEGEN DIE FALSCH GETIPPTE SUBDOMAIN, alle serverseitig:
 * 1. Der Vorschlag kommt aus dem Organisationsnamen (`subdomainSuggestion`).
 * 2. Die Verfügbarkeit wird gegen CRM UND Coolify geprüft, bevor irgendetwas
 *    passiert — und beim Anlegen noch einmal, weil dazwischen Zeit vergeht.
 * 3. Die Vorschau ist PFLICHT und liegt als Zeile in der Datenbank. Ein
 *    direkter Aufruf des Anlege-Endpunkts ohne sie wird abgewiesen.
 */
@Injectable()
export class InstanceService {
  private readonly logger = new Logger(InstanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly coolifyConfig: CoolifyConfigService,
    private readonly provisioning: InstanceProvisioningService,
    @Inject(PROVISIONER) private readonly provisioner: Provisioner,
  ) {}

  private hostFor(subdomain: string): string {
    return instanceHost(this.coolifyConfig.contract(), subdomain);
  }

  private applicationName(subdomain: string): string {
    return `${this.coolifyConfig.contract().instancePrefix}-${subdomain}`;
  }

  /** Die Instanz einer Organisation — oder `null`, wenn es keine gibt. */
  async get(companyId: string): Promise<InstanceDetail | null> {
    const instance = await this.prisma.instance.findUnique({
      where: { companyId },
      include: {
        metrics: { orderBy: { date: 'desc' }, take: 60 },
        backups: { orderBy: { date: 'desc' }, take: 1 },
      },
    });
    if (instance === null) return null;
    return toInstanceDetail(
      instance,
      instance.metrics,
      instance.backups,
      this.coolifyConfig.contract().baseDomain,
      instance.setupTokenEncrypted !== null,
    );
  }

  /**
   * Der Einrichtungslink im Klartext — der einzige Weg an das Geheimnis.
   *
   * [A.7] Vorher stand der fertige Link in der Antwort von `GET :id/instanz`,
   * also hinter blosser Sitzung, ohne zweiten Faktor, ohne Drosselung und ohne
   * Nachweis. Ein erbeutetes Sitzungs-Cookie hätte genügt, um bei jeder noch
   * nicht eingerichteten Kundeninstanz Administrator zu werden. Dieselbe
   * Schutzstufe wie bei den Zahlungsdaten ist hier das Mindeste.
   *
   * DER ZUGRIFF SELBST STEHT IM NACHWEIS — auch der erfolglose, denn dass
   * jemand es versucht hat, ist die eigentliche Auskunft.
   */
  async invitationLink(
    companyId: string,
    actor: Actor,
    source: InquirySource,
  ): Promise<{ invitationLink: string | null }> {
    // Erst die Organisation: Für eine fremde oder ausgedachte ID gibt es ein
    // 404 wie bei den Zahlungsdaten — und KEINEN Audit-Eintrag, sonst liesse
    // sich das Nachweisprotokoll mit 5 Anfragen je Minute füllen.
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true },
    });
    if (!company) throw new CompanyNotFoundError();

    const instance = await this.prisma.instance.findUnique({
      where: { companyId },
      include: { metrics: { orderBy: { date: 'desc' }, take: 60 } },
    });

    await this.audit.log({
      userId: actor.userId,
      actor: actor.name,
      action: AUDIT_ACTION.instanceInvitationLinkRead,
      objectType: 'Instance',
      objectId: instance?.id ?? null,
      // KEIN Geheimnis und kein Link im Nachweis — nur, dass gelesen wurde.
      afterValue: { subdomain: instance?.subdomain ?? null },
      ...source,
    });

    if (instance === null) return { invitationLink: null };

    const status = instance.status as InstanceStatus;
    const values =
      status === 'active' ? toMetrics(instance.metrics, today()) : null;
    return {
      invitationLink: invitationLinkFrom(
        status,
        values,
        instance.subdomain,
        this.coolifyConfig.contract().baseDomain,
        this.setupToken(instance.setupTokenEncrypted, instance.subdomain),
        instance.setupCompletedAt !== null,
        this.coolifyConfig.contract().setupPath,
        this.coolifyConfig.contract().subdomainPattern,
      ),
    };
  }

  /**
   * Entschlüsselt das Geheimnis des Einladungslinks — oder gibt `null`.
   *
   * `null` bei einem nicht lesbaren Wert (getauschter `CONTROL_CONFIG_KEY`)
   * ist hier RICHTIG und nicht still: Der Link fällt dann sichtbar weg, statt
   * mit einem kaputten Geheimnis angeboten zu werden, das auf der Instanz
   * abgewiesen würde. Der Grund steht im Log.
   */
  private setupToken(encrypted: string | null, subdomain: string): string | null {
    if (encrypted === null) return null;
    try {
      return this.crypto.decrypt(encrypted);
    } catch {
      this.logger.error(
        `Einladungsgeheimnis von ${subdomain} ist nicht entschlüsselbar. ` +
          'Wurde CONTROL_CONFIG_KEY getauscht? Der Einladungslink wird nicht ' +
          'angeboten.',
      );
      return null;
    }
  }

  /**
   * Ist die Subdomain frei? Geprüft wird an BEIDEN Orten.
   *
   * Das CRM allein genügt nicht: In Coolify kann eine Anwendung stehen, die
   * hier nie eingetragen wurde (genau der Fall, den der Abgleich als „verwaist"
   * meldet). Sie zu überschreiben wäre der stille Datenverlust, um den es geht.
   */
  async checkSubdomain(value: string): Promise<{ available: boolean }> {
    const subdomain = normalizeSubdomain(value);
    const reason = subdomainError(subdomain);
    if (reason !== null) throw new SubdomainInvalidError(reason);
    return { available: !(await this.isTaken(subdomain)) };
  }

  private async isTaken(subdomain: string): Promise<boolean> {
    const inCrm = await this.prisma.instance.findUnique({
      where: { subdomain },
      select: { id: true },
    });
    if (inCrm !== null) return true;

    const fqdn = this.hostFor(subdomain);
    try {
      const applications = await this.provisioner.status();
      return applications.some(
        (a) => a.domains.includes(fqdn) || a.name === this.applicationName(subdomain),
      );
    } catch (exception) {
      // COOLIFY NICHT ERREICHBAR HEISST NICHT „FREI".
      //
      // Eine Verfügbarkeitsprüfung, die im Ausfall „ja, nimm sie" antwortet,
      // ist gefährlicher als gar keine: Sie führt genau dann zum
      // Überschreiben, wenn ohnehin niemand hinsieht. Deshalb gilt die
      // Subdomain im Zweifel als vergeben, und das Anlegen scheitert später
      // ohnehin sichtbar.
      const reason = exception instanceof Error ? exception.message : String(exception);
      this.logger.error(
        `Verfügbarkeit von ${fqdn} nicht prüfbar (${reason}). Die Subdomain ` +
          'gilt vorsorglich als vergeben.',
      );
      return true;
    }
  }

  /**
   * SCHRITT 1 VON ZWEI: die Pflicht-Vorschau.
   *
   * Sie legt eine Zeile an, die der Anlege-Endpunkt später atomar verbraucht.
   * Ohne diese Zeile geht dort nichts durch — die Vorschau ist damit eine
   * Eigenschaft des Servers und keine Höflichkeit der Oberfläche (E3-9).
   *
   * Die Vorschau zeigt AUSSCHLIESSLICH NAMEN von Umgebungsvariablen, nie ihre
   * Werte: Der Kennzahlen-Token entsteht erst beim Anlegen und ist danach nur
   * noch verschlüsselt vorhanden.
   */
  /**
   * Lehnt ab, wenn für neue Instanzen keine Versanddaten hinterlegt sind.
   *
   * Nur wenn Coolify ÜBERHAUPT eingerichtet ist — fehlt schon das, meldet das
   * die bestehende Prüfung, und zwar mit dem richtigen Grund.
   */
  private checkSendData(): void {
    const coolifyConfig = this.coolifyConfig.read();
    if (coolifyConfig !== null && coolifyConfig.instanceSmtp === null) {
      throw new InstanceSendMissingError();
    }
  }

  async createPreview(
    companyId: string,
    value: string,
    actor: Actor,
    source?: InquirySource,
  ): Promise<InstancePreviewResponse> {
    // Vor allem anderen: Eine Vorschau für etwas, das sich nicht anlegen
    // lässt, wäre ein Versprechen ohne Deckung.
    this.checkSendData();

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true, name: true, instance: { select: { subdomain: true } } },
    });
    if (company === null) throw new CompanyNotFoundError();
    if (company.instance !== null) {
      throw new InstanceExistsAlreadyError(company.instance.subdomain);
    }

    const subdomain = normalizeSubdomain(value);
    const reason = subdomainError(subdomain);
    if (reason !== null) throw new SubdomainInvalidError(reason);
    if (await this.isTaken(subdomain)) {
      throw new SubdomainTakenError(subdomain);
    }

    const validUntil = new Date(Date.now() + PREVIEW_VALID_MINUTES * 60_000);
    const preview = await this.prisma.instancePreview.create({
      data: { companyId, subdomain, validUntil },
    });

    await this.audit.log({
      userId: actor.userId,
      actor: actor.name,
      action: AUDIT_ACTION.instancePreviewGenerated,
      objectType: 'Instance',
      objectId: null,
      afterValue: { companyId, subdomain, previewId: preview.id },
      ip: source?.ip ?? null,
      userAgent: source?.userAgent ?? null,
    });

    const suggested = subdomainSuggestion(company.name);
    return {
      previewId: preview.id,
      subdomain,
      url: `https://${this.hostFor(subdomain)}`,
      applicationName: this.applicationName(subdomain),
      databaseName: DATABASE_NAME,
      environmentVariables: [...ENVIRONMENT_VARIABLES],
      validUntil: validUntil.toISOString(),
      deviatesBySuggestionFrom: subdomain !== suggested,
      suggestedSubdomain: suggested,
    };
  }

  /**
   * SCHRITT 2 VON ZWEI: anlegen — der erste der beiden erlaubten
   * Schreibvorgänge gegen eine Kundeninstanz.
   *
   * Die Anfrage wird ANGENOMMEN, nicht abgewartet: Der Aufrufer bekommt die
   * Antwort, sobald die `Instanz`-Zeile mit `wird_erstellt` steht. Der
   * minutenlange Teil (Coolify-Anlage, Deployment, Health-Check) läuft danach
   * im Hintergrund und schreibt seinen Zwischenstand nach `meldung` — genau
   * deshalb überlebt der Vorgang das Verlassen der Seite.
   *
   * DREI SCHRANKEN, jede gegen ein anderes Rennen:
   * 1. Die Vorschau wird ATOMAR verbraucht (`updateMany` mit `verwendetAm:
   *    null`). Zwei gleichzeitige Anfragen: genau eine gewinnt.
   * 2. `Instanz.companyId` ist `@unique` — zwei Instanzen je Organisation
   *    lässt die Datenbank nicht zu.
   * 3. `Instanz.subdomain` ist `@unique` — dieselbe Subdomain zweimal ebenso
   *    wenig.
   */
  async create(
    companyId: string,
    value: string,
    actor: Actor,
    source?: InquirySource,
  ): Promise<InstanceDetail> {
    const subdomain = normalizeSubdomain(value);
    const reason = subdomainError(subdomain);
    if (reason !== null) throw new SubdomainInvalidError(reason);

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true, instance: { select: { subdomain: true } } },
    });
    if (company === null) throw new CompanyNotFoundError();
    if (company.instance !== null) {
      throw new InstanceExistsAlreadyError(company.instance.subdomain);
    }

    await consumePreview(this.prisma, companyId, subdomain);

    // ZWEITE Verfügbarkeitsprüfung, NACH der Vorschau: zwischen Vorschau und
    // Bestätigung können Minuten liegen, und in dieser Zeit kann jemand
    // dieselbe Subdomain in Coolify angelegt haben.
    if (await this.isTaken(subdomain)) {
      throw new SubdomainTakenError(subdomain);
    }

    // Und noch einmal hier: Zwischen Vorschau und Bestätigung kann die
    // Konfiguration sich ändern. Geprüft wird, BEVOR die Zeile entsteht.
    this.checkSendData();

    const metricsToken = randomBytes(32).toString('hex');
    // Das Geheimnis des Einladungslinks ([K4]). Ohne es wäre der Link die frei
    // erratbare Adresse `/setup`, und wer die frische Subdomain zuerst
    // erreicht, würde Admin der Organisation.
    const setupToken = randomBytes(32).toString('hex');
    const instance = await this.prisma.instance.create({
      data: {
        companyId,
        subdomain,
        status: 'provisioning',
        message: 'Anwendung wird in Coolify angelegt …',
        // Beide Geheimnisse liegen AB SOFORT nur verschlüsselt vor (AES-256-GCM
        // über den bestehenden KryptoService). Der Klartext existiert nur in
        // diesen Variablen, geht an Coolify und ist danach weg.
        metricsTokenEncrypted: this.crypto.encrypt(metricsToken),
        setupTokenEncrypted: this.crypto.encrypt(setupToken),
      },
    });

    await this.audit.log({
      userId: actor.userId,
      actor: actor.name,
      action: AUDIT_ACTION.instanceCreated,
      objectType: 'Instance',
      objectId: instance.id,
      // Kein Token, auch nicht verschlüsselt: `saeubereFuerAudit` entfernt
      // Feldnamen mit „token" ohnehin, aber er wird hier gar nicht erst
      // übergeben.
      afterValue: { companyId, subdomain, status: 'provisioning' },
      ip: source?.ip ?? null,
      userAgent: source?.userAgent ?? null,
    });

    // Ab hier läuft es im Hintergrund weiter. Der Fehlerfall landet als
    // `meldung` an der Instanz — kein stiller Halbzustand (E3-12).
    void this.provisioning
      .executeFrom(instance.id, subdomain, { metricsToken, setupToken })
      .catch((exception: unknown) => {
        const text = exception instanceof Error ? exception.message : String(exception);
        this.logger.error(`Aufbau von ${subdomain} abgebrochen: ${text}`);
      });

    return toInstanceDetail(instance, [], [], this.coolifyConfig.contract().baseDomain, true);
  }

  /**
   * Der zweite und letzte erlaubte Schreibvorgang: stoppen, letzte Sicherung
   * auslösen, Status setzen.
   *
   * ES WIRD NICHTS GELÖSCHT (R1/R4). Die Container werden angehalten, das
   * Datenvolumen bleibt. Es gibt keinen Codepfad zurück — die Wiederherstellung
   * ist ein Handgriff in Coolify und in `docs/operations/backup-and-recovery.md`
   * beschrieben.
   */
  async archive(
    companyId: string,
    actor: Actor,
    source?: InquirySource,
  ): Promise<InstanceDetail> {
    const instance = await this.prisma.instance.findUnique({
      where: { companyId },
    });
    if (instance === null) throw new InstanceNotFoundError();
    if (instance.status !== 'active') {
      throw new InstanceStatusMismatchError(instance.status, 'active');
    }

    // Bedingter Schreibvorgang: Wer zweimal klickt oder zwei Fenster offen
    // hat, löst den Coolify-Aufruf trotzdem nur einmal aus.
    //
    // ER WAR IMMER RICHTIG — und ein Rennen, das hier trotzdem sichtbar
    // wurde, hatte seine Ursache woanders: Der AUFBAU-Hintergrundlauf setzte
    // am Ende bedingungslos `status: 'aktiv'` und machte damit eine
    // zwischenzeitliche Archivierung rückgängig. Nachzulesen in
    // `instance-provisioning.service.ts`; hier stand vorübergehend eine Sperre, die
    // das Symptom behandelt hätte und nicht die Ursache.
    const adopted = await this.prisma.instance.updateMany({
      where: { id: instance.id, status: 'active' },
      // [H7]: „und gesichert" stand hier und war falsch — dieser Weg stösst
      // KEINE Sicherung an, er stoppt nur. Der Text geht in die Oberfläche;
      // wer ihn liest, verliesse sich auf eine Sicherung, die es nicht gibt.
      // Welcher Sicherungsstand tatsächlich vorliegt, steht in der Meldung,
      // die der Hintergrundlauf danach schreibt („Letzte Sicherung …").
      data: { status: 'stopped', message: 'Die Instanz wird gestoppt.' },
    });
    if (adopted.count !== 1) {
      throw new InstanceStatusMismatchError(instance.status, 'active');
    }

    await this.audit.log({
      userId: actor.userId,
      actor: actor.name,
      action: AUDIT_ACTION.instanceArchived,
      objectType: 'Instance',
      objectId: instance.id,
      beforeValue: { status: instance.status },
      afterValue: { status: 'stopped', subdomain: instance.subdomain },
      ip: source?.ip ?? null,
      userAgent: source?.userAgent ?? null,
    });

    void this.provisioning.executeArchivingFrom(instance.id).catch((exception: unknown) => {
      const text = exception instanceof Error ? exception.message : String(exception);
      this.logger.error(`Archivierung von ${instance.subdomain} abgebrochen: ${text}`);
    });

    const state = await this.get(companyId);
    if (state === null) throw new InstanceNotFoundError();
    return state;
  }

  /**
   * VERWIRFT EINE GESCHEITERTE ERSTELLUNG — den einzigen Weg aus der Sackgasse.
   *
   * WAS OHNE SIE PASSIERTE ([W4]): Scheiterte das Anlegen, blieb die Instanz
   * auf `wird_erstellt` stehen. `create` lehnte danach JEDEN weiteren Versuch
   * ab („Instanz besteht bereits"), und einen Löschpfad gibt es bewusst nicht.
   * Die Organisation war damit dauerhaft ohne Instanz UND ohne Weg zu einer.
   *
   * WARUM DAS KEINE DRITTE SCHREIBOPERATION IST (R1): Diese Handlung fasst
   * Coolify NICHT AN. Sie ist überhaupt nur erlaubt, wenn dort GAR NICHTS
   * entstanden ist — kein `coolifyApplicationId`. Was verworfen wird, ist eine
   * Zeile über einen Vorgang, der nie stattgefunden hat.
   *
   * WARUM SIE TROTZDEM LÖSCHT UND NICHT NUR EINEN STATUS SETZT: `Instanz`
   * hängt mit `@unique` an der Organisation. Eine stehengelassene Zeile — in
   * welchem Status auch immer — blockiert jede neue Instanz für immer. Der
   * Nachweis geht dabei nicht verloren: Audit-Eintrag und Systemnotiz stehen
   * VOR dem Verwerfen und überleben es (R6).
   *
   * VIER BEDINGUNGEN, alle serverseitig geprüft:
   * 1. Status ist `wird_erstellt` — eine laufende oder archivierte Instanz
   *    wird hier niemals angefasst.
   * 2. In Coolify existiert nichts — entweder nie angelegt
   *    (`coolifyApplicationId === null`) oder dort nachweislich von Hand
   *    entfernt (Coolify antwortet 404). Ein Ausfall zählt NICHT als entfernt.
   * 3. Es hängen keine Kennzahlen daran.
   * 4. Es hängen keine Sicherungen daran.
   */
  async discardCreation(
    companyId: string,
    actor: Actor,
    source?: InquirySource,
  ): Promise<{ discarded: true }> {
    const instance = await this.prisma.instance.findUnique({
      where: { companyId },
      select: {
        id: true,
        subdomain: true,
        status: true,
        message: true,
        coolifyApplicationId: true,
        _count: { select: { metrics: true, backups: true } },
      },
    });
    if (instance === null) throw new InstanceNotFoundError();

    if (instance.status !== 'provisioning') {
      throw new DiscardNotPossibleError(
        'Verwerfen geht nur, solange die Erstellung nicht abgeschlossen ist. ' +
          'Eine laufende Instanz wird archiviert, nicht verworfen.',
      );
    }
    // =================================================================
    // STEHT IN COOLIFY NOCH ETWAS? — gelesen, nicht vermutet
    // =================================================================
    //
    // Hier stand nur `coolifyApplicationId !== null` → ablehnen. Die Meldung
    // verlangte „dort von Hand aufräumen" — und danach ging es TROTZDEM nicht
    // weiter: Die Kennung blieb in der Zeile stehen, auch wenn die Anwendung
    // in Coolify längst gelöscht war. Die Anweisung führte in eine zweite
    // Sackgasse. Gemessen am 11.09.2026 an einer Kundeninstanz.
    //
    // Jetzt wird GEFRAGT. Kennt Coolify die Anwendung nicht mehr (404), ist
    // der Zustand derselbe wie „nie angelegt", und Verwerfen ist erlaubt.
    // Coolify wird dabei NUR GELESEN (R1).
    //
    // EIN AUSFALL IST KEIN „WEG" ([K2]). Wirft die Abfrage, bleibt es bei der
    // Ablehnung — sonst würde ein nicht erreichbares Coolify zur Freigabe,
    // und die Zeile verschwände neben einer laufenden Anwendung.
    let fromHandRemoved = false;
    if (instance.coolifyApplicationId !== null) {
      let present: boolean;
      try {
        present =
          (await this.provisioner.status(instance.coolifyApplicationId)) !== null;
      } catch {
        throw new DiscardNotPossibleError(
          'Coolify ist gerade nicht erreichbar. Ob die Anwendung ' +
            `${this.applicationName(instance.subdomain)} dort noch steht, lässt sich deshalb ` +
            'nicht prüfen — bitte später noch einmal versuchen.',
        );
      }
      if (present) {
        throw new DiscardNotPossibleError(
          `In Coolify steht noch die Anwendung ${this.applicationName(instance.subdomain)} ` +
            `(${instance.coolifyApplicationId}). Lösche sie dort von Hand — danach ` +
            'lässt sich die Erstellung hier verwerfen. Dieses System fasst sie ' +
            'selbst nicht an.',
        );
      }
      fromHandRemoved = true;
    }
    if (instance._count.metrics > 0 || instance._count.backups > 0) {
      throw new DiscardNotPossibleError(
        'An dieser Instanz hängen bereits Kennzahlen oder Sicherungen. Sie ' +
          'wird nicht verworfen — der Nachweis bleibt.',
      );
    }

    // Nachweis ZUERST. Er überlebt das Verwerfen; die Zeile nicht.
    await this.audit.log({
      userId: actor.userId,
      actor: actor.name,
      action: AUDIT_ACTION.instanceCreationDiscarded,
      objectType: 'Instance',
      objectId: instance.id,
      beforeValue: {
        subdomain: instance.subdomain,
        status: instance.status,
        message: instance.message,
        coolifyApplicationId: instance.coolifyApplicationId,
        fromHandRemoved,
      },
      ip: source?.ip ?? null,
      userAgent: source?.userAgent ?? null,
    });
    await writeSystemNote(
      this.prisma,
      companyId,
      fromHandRemoved
        ? `Die Erstellung der Instanz ${instance.subdomain} wurde verworfen. Die ` +
            'halb angelegte Anwendung war in Coolify bereits von Hand entfernt; ' +
            'dieses System hat dort nichts angefasst. Eine neue Instanz lässt ' +
            'sich jetzt wieder anlegen.'
        : `Die Erstellung der Instanz ${instance.subdomain} wurde verworfen. In ` +
            'Coolify war nichts entstanden, dort wurde nichts angefasst. Eine ' +
            'neue Instanz lässt sich jetzt wieder anlegen.',
    );

    // Bedingt: Wer zweimal klickt, verwirft trotzdem nur einmal — und wenn
    // der Hintergrundaufbau die Zeile zwischenzeitlich weitergebracht hat,
    // trifft die Bedingung nicht mehr zu und es passiert nichts.
    const result = await this.prisma.instance.deleteMany({
      where: {
        id: instance.id,
        status: 'provisioning',
        // DIESELBE Kennung, die eben geprüft wurde — nicht mehr pauschal
        // `null`. Hat der Hintergrundaufbau inzwischen eine andere
        // eingetragen, trifft die Bedingung nicht, und es passiert nichts.
        coolifyApplicationId: instance.coolifyApplicationId,
      },
    });
    if (result.count !== 1) {
      throw new DiscardNotPossibleError(
        'Die Erstellung ist zwischenzeitlich weitergelaufen. Lade die Seite ' +
          'neu und sieh dir den aktuellen Stand an.',
      );
    }
    return { discarded: true };
  }

  /**
   * =====================================================================
   * „ERNEUT PRÜFEN" — ausgerollt, aber noch nicht erreichbar
   * =====================================================================
   *
   * DREI BEDINGUNGEN, alle serverseitig: Die Instanz ist noch im Aufbau, in
   * Coolify steht ihre Anwendung, und der Aufbau hat genau mit
   * „Erreichbarkeit ausstehend" aufgehört. Jeder andere Zustand — läuft
   * noch, gescheitert, längst aktiv — wird abgewiesen.
   *
   * Es wird NUR die Instanz gefragt, nicht Coolify angefasst (R1).
   */
  async checkReachability(
    companyId: string,
    actor: Actor,
  ): Promise<{ reachable: boolean }> {
    const instance = await this.prisma.instance.findUnique({
      where: { companyId },
      select: {
        id: true,
        subdomain: true,
        status: true,
        message: true,
        coolifyApplicationId: true,
      },
    });
    if (instance === null) throw new InstanceNotFoundError();
    if (
      instance.status !== 'provisioning' ||
      instance.coolifyApplicationId === null ||
      !(instance.message ?? '').startsWith(REACHABILITY_PENDING)
    ) {
      throw new ReachabilityNotCheckableError();
    }
    const reachable = await this.provisioning.checkReachability(
      instance.id,
      instance.subdomain,
      actor,
    );
    return { reachable };
  }

  /**
   * Alle Instanzen für die Übersicht „Instanzen".
   *
   * Sortiert nach Subdomain — eine Instanz sucht man an ihrer Adresse. Keine
   * Geheimnisse und keine Kennzahlen: Die Liste ist ein Wegweiser in die
   * Organisation, keine zweite Detailseite.
   */
  async all(): Promise<InstanceListenEntry[]> {
    const rows = await this.prisma.instance.findMany({
      orderBy: { subdomain: 'asc' },
      select: {
        id: true,
        subdomain: true,
        status: true,
        createdAt: true,
        company: { select: { id: true, name: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      subdomain: row.subdomain,
      url: `https://${this.hostFor(row.subdomain)}`,
      status: row.status as InstanceListenEntry['status'],
      createdAt: row.createdAt.toISOString(),
      company: row.company,
    }));
  }

  /** Der Vorschlag aus dem Organisationsnamen, für das leere Formularfeld. */
  async suggestion(companyId: string): Promise<{ subdomain: string }> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { name: true },
    });
    if (company === null) throw new CompanyNotFoundError();
    return { subdomain: subdomainSuggestion(company.name) };
  }
}

/** Der heutige Tag als `Date` mit Nullzeit — für `@db.Date`-Spalten. */
export function todayAsDate(): Date {
  return toDate(today());
}

/** `YYYY-MM-DD` aus einem `@db.Date`-Wert. */
export function dayFrom(value: Date): string {
  return dateStringFromDate(value);
}
