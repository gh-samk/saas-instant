import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import { baseUrl } from '../common/base-url';
import { MailService } from '../mail/mail.service';
import { CompanyNotFoundError } from '../companies/company.errors';
import { missingDetails } from '../companies/completeness';
import { PrismaService } from '../prisma/prisma.service';
import { IntakeAccessService, ACCESS_VALID_MS } from './intake-access.service';

/** Was aus einem Versand des Aufnahmelinks wurde. */
export interface IntakeLinkSend {
  sent: boolean;
  email: string;
  reason?: 'no_address' | 'send_failed';
}

/**
 * ===========================================================================
 * DEN AUFNAHMELINK VERSCHICKEN — an EINER Stelle
 * ===========================================================================
 *
 * Zwei Aufrufer brauchen genau dasselbe: der automatische Versand beim
 * Statuswechsel auf `trial` und der Knopf „Erneut senden" in der
 * Verwaltung. Beide erzeugen einen Zugang, verschicken die Mail, vermerken
 * den Versand und schreiben einen Audit-Eintrag.
 *
 * WARUM EIN EIGENER DIENST UND NICHT IM `CompanyService`: Der hätte
 * dafür drei neue Abhängigkeiten bekommen — Konfiguration, Mailversand und
 * Zugangsverwaltung —, und vier Testdateien hätten ihre Aufbauten nachziehen
 * müssen, ohne dass eine davon etwas mit Aufnahme zu tun hat. Eine Klasse,
 * deren Konstruktor von zwei auf fünf wächst, sagt damit selbst, dass sie
 * gerade eine zweite Aufgabe bekommt.
 *
 * MELDET STATT ZU WERFEN. Beim Statuswechsel ist der Wechsel bereits
 * vollzogen; ihn wegen eines Mailfehlers scheitern zu lassen wäre der
 * grössere Schaden — die Betreiberin müsste raten, ob er nun gilt.
 */
@Injectable()
export class IntakeSendService {
  private readonly logger = new Logger(IntakeSendService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly accesses: IntakeAccessService,
  ) {}

  /** Tage, die der Link gilt — für den Mailtext. */
  private get validDays(): number {
    return Math.round(ACCESS_VALID_MS / (24 * 60 * 60 * 1000));
  }

  async send(
    companyId: string,
    companyName: string,
    email: string | null,
    actor: { name: string; userId: string | null },
    automatic: boolean,
  ): Promise<IntakeLinkSend> {
    const target = (email ?? '').trim();
    if (target === '') {
      // KEIN Fehler: Eine Organisation ohne hinterlegte Adresse ist am Anfang
      // der Normalfall. Die Karte in der Verwaltung sagt es und bietet den
      // Versand an, sobald eine Adresse dasteht.
      return { sent: false, email: '', reason: 'no_address' };
    }

    try {
      const { token, accessId, expiresAt } = await this.accesses.create(
        companyId,
        actor.name,
        actor.userId,
      );
      await this.mail.sendIntakeLink(
        target,
        companyName,
        `${baseUrl(this.config)}/api/intake/${token}`,
        this.validDays,
      );
      await this.accesses.noteSend(accessId);
      await this.audit.log({
        userId: actor.userId,
        actor: actor.name,
        action: AUDIT_ACTION.intakeAccessSent,
        objectType: 'Company',
        objectId: companyId,
        // Weder Token noch Link — der Link IST der Token.
        afterValue: { automatic, expiresAt: expiresAt.toISOString() },
      });
      return { sent: true, email: target };
    } catch (error) {
      // LAUT, ABER NICHT TÖDLICH. Genau der Fall, in dem jemand später fragt,
      // warum niemand das Formular ausgefüllt hat — er gehört ins Log, nicht
      // ins Schweigen.
      this.logger.error(
        `Aufnahmelink zu Organisation ${companyId} ging nicht hinaus: ` +
          `${error instanceof Error ? error.message : 'unbekannt'}.`,
      );
      return { sent: false, email: target, reason: 'send_failed' };
    }
  }

  /**
   * =======================================================================
   * DER BETREIBERIN SAGEN, DASS DIE ANGABEN DA SIND
   * =======================================================================
   *
   * Systemnotiz und Statuswechsel stehen im CRM — beides sieht nur, wer
   * hinschaut. Die Aufnahme ist aber der Augenblick, in dem etwas zu tun ist:
   * Instanz anlegen, Rechnung vorbereiten. Deshalb geht sie zusätzlich ins
   * Postfach, aus demselben Grund wie die Anfrage-Benachrichtigung — läge das
   * CRM nachts still, läge der Vorgang trotzdem im Postfach.
   *
   * SIE NENNT KEINE IBAN und keine übermittelten Werte, nur DASS ein Mandat
   * erteilt wurde und dessen Referenz. Eine Mail ist kein Ort für Bankdaten;
   * wer sie sehen will, weist sich in der Verwaltung aus.
   *
   * SIE SCHEITERT LEISE. Die Angaben stehen bereits in der Datenbank; den
   * Eingang wegen eines Mailfehlers rückabzuwickeln wäre der grössere
   * Schaden. Ins Log gehört er trotzdem.
   */
  async reportReceipt(
    companyId: string,
    companyName: string,
    mandateReference: string | null,
  ): Promise<void> {
    const recipient = (
      this.config.get<string>('CONTROL_INQUIRY_RECIPIENT') ?? ''
    ).trim();
    if (recipient === '') {
      this.logger.error(
        'CONTROL_INQUIRY_RECIPIENT ist nicht gesetzt — es ging KEINE ' +
          'Eingangsmeldung hinaus. Die Angaben stehen in der Datenbank ' +
          `(Organisation ${companyId}).`,
      );
      return;
    }
    try {
      await this.mail.sendInquiryNotification(
        recipient,
        'Aufnahmeangaben eingegangen',
        [
          `${companyName} hat das Aufnahmeformular ausgefüllt. Die ` +
            'Angaben stehen am Datensatz.',
          '',
          `Organisation: ${companyName}`,
          mandateReference
            ? `SEPA-Mandat erteilt, Referenz ${mandateReference}`
            : 'Zahlung per Überweisung — kein Mandat nötig',
          '',
          'Als Nächstes: Angaben durchsehen, Instanz anlegen, Rechnung ' +
            'vorbereiten. Die Bankverbindung steht nur in der Verwaltung — ' +
            'sie gehört nicht in eine E-Mail:',
          `${baseUrl(this.config)}/companies/${companyId}`,
        ],
      );
    } catch (error) {
      this.logger.error(
        `Eingangsmeldung zu Organisation ${companyId} ging nicht ` +
          `hinaus: ${error instanceof Error ? error.message : 'unbekannt'}.`,
      );
    }
  }
}

/**
 * ===========================================================================
 * WAS DIE VERWALTUNG AM AUFNAHMEZUGANG TUN KANN
 * ===========================================================================
 *
 * Zustand lesen, erneut senden, den Link im Klartext zeigen. Alle drei
 * brauchen die Organisation nur, um Name und Adresse zu lesen — sie sind
 * Aufnahme-Vorgänge, keine Organisations-Vorgänge.
 *
 * DESHALB HIER UND NICHT IM `CompanyService`. Der wäre dafür von zwei
 * auf fünf Abhängigkeiten gewachsen, und vier fremde Testdateien hätten ihre
 * Aufbauten ein zweites Mal nachziehen müssen. Ein Konstruktor, der bei einer
 * neuen Aufgabe um drei Einträge wächst, sagt selbst, dass die Aufgabe
 * woandershin gehört.
 */
@Injectable()
export class IntakeManagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly accesses: IntakeAccessService,
    private readonly send: IntakeSendService,
  ) {}

  /**
   * Zustand des Zugangs für die Karte. Nennt NIE den Token.
   *
   * `missing` kommt aus derselben `missingDetails()`, die auch das Formular
   * und der Statuswechsel lesen — die Karte soll nicht ihre eigene Vorstellung
   * von „vollständig" entwickeln.
   */
  async state(companyId: string) {
    const company = await this.read(companyId);
    const { contactEmail, intakeCompletedAt, ...checkable } =
      company;
    return {
      ...(await this.accesses.state(companyId)),
      address: contactEmail,
      completedAt: intakeCompletedAt,
      missing: missingDetails({ contactEmail, ...checkable }),
    };
  }

  /** Schickt den Link erneut an die HINTERLEGTE Adresse. */
  async sendAgain(
    companyId: string,
    actor: { name: string; userId: string | null },
  ): Promise<IntakeLinkSend> {
    const company = await this.read(companyId);
    return this.send.send(
      companyId,
      company.name,
      company.contactEmail,
      actor,
      false,
    );
  }

  /**
   * Erzeugt einen Zugang und gibt den Klartext-Link heraus — EINMAL.
   *
   * Er zieht dabei einen offenen zurück. Den alten Klartext gibt es nicht
   * mehr; das ist kein Mangel, sondern die Eigenschaft, die den Hash in der
   * Datenbank überhaupt sinnvoll macht.
   */
  async showLink(
    companyId: string,
    actor: { name: string; userId: string | null },
  ): Promise<{ link: string; expiresAt: string }> {
    await this.read(companyId);
    const { token, expiresAt } = await this.accesses.create(
      companyId,
      actor.name,
      actor.userId,
    );
    return {
      link: `${baseUrl(this.config)}/api/intake/${token}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  private async read(companyId: string) {
    const row = await this.prisma.company.findUnique({
      where: { id: companyId },
      // Die Auswahl deckt `ToCheck` ab, damit `missingDetails()` hier
      // rechnen kann, ohne die Organisation ein zweites Mal zu laden.
      select: {
        name: true,
        legalForm: true,
        street: true,
        houseNumber: true,
        postalCode: true,
        city: true,
        contactName: true,
        contactEmail: true,
        contactPhone: true,
        paymentInterval: true,
        paymentMethod: true,
        iban: true,
        accountHolder: true,
        sepaMandateGrantedAt: true,
        intakeCompletedAt: true,
      },
    });
    if (!row) throw new CompanyNotFoundError();
    return row;
  }
}
