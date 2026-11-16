import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { DeliveryStatus } from '.prisma/control-client';
import { today } from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import { consentEmailIndex, mailRecipientIndex } from '../crypto/field-crypto';
import type { InquirySource } from '../common/inquiry-source';
import { dayReadable } from '../common/calendar';
import { NoMarketingApprovalError } from '../consent/consent.errors';
import { ConsentService } from '../consent/consent.service';
import { MarketingApproval } from '../consent/consent.gate';
import type { ErrorClass } from '../mail/mail.service';
import { isRecipientRelated } from '../mail/mail.service';
import type { FramedMail } from '../mail/layout';
import { htmlFromText } from '../mail/layout';
import { writeSystemNote } from '../notes/system-note';
import { PrismaService } from '../prisma/prisma.service';
import { replace, replaceInHtml, openPlaceholder } from './placeholder';
import {
  NoRecipientError,
  OpenPlaceholderError,
  TestSendWithoutAddressError,
} from './broadcast.errors';
import type { Actor } from './template.service';
import { TemplateService } from './template.service';
import { MarketingMailError, MarketingMailService } from './marketing-mail.service';

/** Wie oft eine einzelne Mail höchstens versucht wird. */
export const MAX_ATTEMPTS = 3;

/**
 * Nach wie vielen ERFOLGLOSEN Zustellungen in Folge eine Adresse stillgelegt
 * wird. „Schlanke Variante" des Auftrags: kein Rückläufer-Postfach auswerten,
 * sondern zählen, was der eigene Postausgang meldet.
 */
export const FAILED_ATTEMPTS_UNTIL_DEACTIVATION = 3;

/**
 * WELCHE FEHLSCHLÄGE GEGEN DIE ADRESSE ZÄHLEN — die Liste steht bewusst
 * NICHT hier.
 *
 * Sie ist eine WHITELIST und liegt bei der Klassifizierung selbst
 * (`mail/mail.service.ts`, `EMPFAENGERBEZOGENE_KLASSEN`). Zwei Listen an zwei
 * Orten liefen auseinander, und die eine hier war die falsche: Sie zählte
 * `unbekannt` mit — den Auffangwert. Damit fiel jeder nicht erkannte Fehler
 * des EIGENEN Postausgangs auf die Seite des Empfängers, und ein DNS-Ausfall
 * legte den Verteiler still ([K1]).
 *
 * Gezählt wird nur, was der Gegenüber nachweislich über den EMPFÄNGER gesagt
 * hat. `verbindung`, `tls`, `anmeldung`, `absender_abgewiesen` und
 * `unbekannt` sind Fehler unserer Seite und legen niemals eine Adresse still.
 */

/** Klassen, bei denen ein weiterer Versuch sinnlos ist. */
const WITHOUT_RETRY: readonly ErrorClass[] = ['empfaenger_abgewiesen'];

export interface EnqueueResult {
  enqueued: number;
  template: string;
}

/**
 * DER FORTSCHRITT EINER EINGESTELLTEN RUNDMAIL — nur Zaehlwerte.
 *
 * Die vier Zahlen ergeben zusammen `gesamt`. `abgewiesen` steht bewusst
 * daneben und nicht unter `fehlgeschlagen`: Eine abgewiesene Zeile ist kein
 * Fehler, sondern die Pruefung beim Versand, die gegriffen hat (R3) — dort hat
 * jemand widerrufen. Beides zusammenzuzaehlen sagte der Betreiberin, es sei
 * etwas schiefgegangen, wo in Wahrheit etwas richtig gelaufen ist.
 *
 * HIER STEHT KEINE ADRESSE UND KEINE KENNUNG EINER EMPFAENGERIN. Die Zahlen
 * entstehen ueber `groupBy` mit `_count`; die Abfrage kann gar keine Zeile
 * herausgeben. Wer wirklich auf der Liste steht, beantwortet weiterhin
 * ausschliesslich `GET /broadcast/empfaenger` — und auch der ist eine Vorhersage
 * und keine Zusage.
 */
export interface SendProgress {
  templateId: string;
  /** Alle je fuer diese Vorlage eingestellten Zeilen. */
  total: number;
  /** Tatsaechlich hinausgegangen. Dieser Teil ist endgueltig. */
  sent: number;
  /** Steht noch in der Warteschlange oder ist gerade im SMTP-Aufruf. */
  open: number;
  /** Nach drei Versuchen aufgegeben oder als abgebrochen vermerkt. */
  failed: number;
  /** Beim Aufnehmen lag keine bestaetigte Einwilligung mehr vor. */
  refused: number;
}

export interface SendRunResult {
  considered: number;
  sent: number;
  refused: number;
  retry: number;
  failed: number;
  /** Zeilen, die aus einem abgebrochenen Lauf hängengeblieben waren. */
  cleanedUp: number;
}

/** Was die Übernahme einer Zeile ergeben hat. */
type Takeover =
  | { kind: 'nothing' }
  | { kind: 'rejected' }
  | {
      kind: 'versenden';
      approval: MarketingApproval;
      subject: string;
      wording: FramedMail;
      unsubscribeLink: string;
      attempt: number;
    };

/**
 * ===========================================================================
 * DIE WARTESCHLANGE — jede Mail einzeln, mit Abstand, mit Prüfung beim Versand
 * ===========================================================================
 *
 * „Nie mehrere Adressen in BCC. Warteschlange, jede Mail einzeln,
 * personalisierter Abmeldelink, einige Sekunden Abstand, Wiederholung bei
 * zeitweiligen Fehlern."
 *
 * ZWEI SCHRITTE, DIE NICHT ZUSAMMENFALLEN DÜRFEN:
 *
 * 1. EINSTELLEN. Der Redaktionsbereich stellt je Empfänger eine Zeile in
 *    `MailVersand` ein, mit dem fertigen, personalisierten Wortlaut. Es geht
 *    dabei NICHTS hinaus.
 * 2. VERSENDEN. Ein Lauf nimmt die Zeilen einzeln auf, prüft für JEDE
 *    unmittelbar vor dem SMTP-Aufruf die Einwilligung und verschickt.
 *
 * Zwischen beidem können Stunden liegen — genau dafür ist die Trennung da.
 * Wer nach dem Einstellen und vor dem Versand widerruft, bekommt nichts: Die
 * Abmeldung setzt die eingestellten Zeilen selbst auf `abgewiesen`, und was
 * sie nicht mehr erwischt, weist das Tor beim Übernehmen ab. Die Prüfung
 * findet SERVERSEITIG BEIM VERSAND statt und nicht bei der Auswahl (R3).
 *
 * WARUM DER ABSTAND: Ein Postausgang, der hundert Mails in zwei Sekunden
 * abfeuert, sieht für jeden Empfängerserver wie eine Massenaussendung aus —
 * mit den entsprechenden Folgen für die Zustellbarkeit der Domäne, und damit
 * auch für die Rechnungen.
 */
@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);
  private runs = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly templates: TemplateService,
    private readonly marketingMail: MarketingMailService,
    private readonly consents: ConsentService,
  ) {}

  // --------------------------------------------------------------- einstellen

  /**
   * Stellt eine Rundmail für ALLE bestätigten Adressen ein.
   *
   * ALLES ODER NICHTS: Bleibt bei einem einzigen Empfänger ein Platzhalter
   * offen, wird gar nichts eingestellt. Eine halb verschickte Rundmail liesse
   * sich nicht zurückholen und nicht wiederholen, ohne die Hälfte doppelt
   * anzuschreiben.
   */
  async enqueue(
    templateId: string,
    actor: Actor,
    source: InquirySource,
  ): Promise<EnqueueResult> {
    const template = await this.templates.loadSendable(templateId, 'marketing');

    // Eigene Abfrage statt `EinwilligungService.empfaenger()`: Hier wird der
    // ABMELDETOKEN gebraucht, und der gehört in keine Antwort, die die
    // Oberfläche zu sehen bekommt.
    const recipient = await this.prisma.consent.findMany({
      where: { status: 'confirmed', unsubscribeToken: { not: null } },
      select: {
        id: true,
        email: true,
        unsubscribeToken: true,
        // Für die Fusszeile: WANN eingewilligt wurde. Der Entwurf verlangt
        // das Datum, und es macht aus einer Behauptung eine nachprüfbare
        // Angabe.
        confirmedAt: true,
        companyId: true,
        company: { select: { name: true } },
      },
    });
    if (recipient.length === 0) throw new NoRecipientError();

    const rows = recipient.map((entry) => {
      const unsubscribeLink = this.consents.unsubscribeLink(entry.unsubscribeToken!);
      const values = {
        organisation: entry.company?.name ?? 'euch',
        abmeldelink: unsubscribeLink,
      };
      const subject = replace(template.subject, values);
      const bodyText = replace(template.contentText, values);
      const bodyHtml = replaceInHtml(bodyFrom(template), values);
      // BEIDE FASSUNGEN werden auf offene Platzhalter geprüft. Ein Platzhalter,
      // der im HTML von einer Auszeichnung zerschnitten ist
      // (`{{organi<strong>sation}}`), wird dort nicht ersetzt, im Textteil
      // aber schon — dann trüge die eine Fassung einen Namen und die andere
      // geschweifte Klammern, und niemand sähe es vor dem Versand.
      const open = [
        ...openPlaceholder(subject),
        ...openPlaceholder(bodyText),
        ...openPlaceholder(bodyHtml),
      ];
      return {
        consentId: entry.id,
        companyId: entry.companyId,
        email: entry.email,
        subject,
        wording: this.marketingMail.wording(
          { subject, html: bodyHtml, text: bodyText, ...structureFrom(template) },
          unsubscribeLink,
          tagFrom(entry.confirmedAt),
        ),
        open,
      };
    });

    const open = [...new Set(rows.flatMap((row) => row.open))];
    if (open.length > 0) throw new OpenPlaceholderError(open);

    await this.prisma.$transaction(async (tx) => {
      await tx.mailDelivery.createMany({
        data: rows.map((row) => ({
          companyId: row.companyId,
          consentId: row.consentId,
          templateId: template.id,
          recipientAddress: row.email,
          channel: 'marketing' as const,
          subject: row.subject,
          contentSnapshot: row.wording.text,
          contentSnapshotHtml: row.wording.html,
          deliveryStatus: 'queued' as const,
        })),
      });
      await this.audit.log(
        {
          userId: actor.userId,
          actor: actor.name,
          action: AUDIT_ACTION.broadcastEnqueued,
          objectType: 'MailTemplate',
          objectId: template.id,
          afterValue: { recipient: rows.length, channel: 'marketing' },
          ...source,
        },
        tx,
      );
    });

    this.logger.log(
      `Rundmail „${template.name}" für ${rows.length} Adressen eingestellt.`,
    );
    return { enqueued: rows.length, template: template.name };
  }

  /**
   * TESTVERSAND — ausschliesslich an die eigene Adresse des angemeldeten
   * Kontos, und mit derselben Prüfung wie jede andere werbliche Mail.
   *
   * DAS IST DIE STELLE, AN DER EIN SCHLUPFLOCH ENTSTANDEN WÄRE. Ein
   * Testversand an eine frei wählbare Adresse ist genau der Weg, auf dem sich
   * R3 „durch Fehlbedienung" umgehen liesse: erst an die eigene Adresse, dann
   * schnell an die der Interessentin, die noch nicht bestätigt hat. Deshalb
   * gibt es hier kein Adressfeld, und deshalb gibt es keinen Sonderweg an der
   * Einwilligung vorbei.
   *
   * Praktisch heisst das: Wer testen will, trägt seine eigene Adresse einmal
   * über das Anmeldeformular ein und bestätigt sie. Das ist zumutbar — und es
   * ist zugleich der einzige ehrliche Test, weil dabei auch der
   * Bestätigungsweg selbst geprüft wird.
   */
  async testSend(
    templateId: string,
    user: { id: string; username: string; email: string | null },
    source: InquirySource,
  ): Promise<{ sent: boolean; reason?: string }> {
    const template = await this.templates.loadSendable(templateId, 'marketing');
    if (!user.email) throw new TestSendWithoutAddressError();

    const entry = await this.prisma.consent.findFirst({
      where: { emailIdx: consentEmailIndex(user.email) },
      select: {
        id: true,
        email: true,
        unsubscribeToken: true,
        companyId: true,
        company: { select: { name: true } },
        status: true,
      },
    });
    if (!entry || entry.status !== 'confirmed' || !entry.unsubscribeToken) {
      throw new NoMarketingApprovalError(entry?.status ?? 'kein_eintrag');
    }

    const unsubscribeLink = this.consents.unsubscribeLink(entry.unsubscribeToken);
    const values = {
      organisation: entry.company?.name ?? 'euch',
      abmeldelink: unsubscribeLink,
    };
    const subject = `[Testversand] ${replace(template.subject, values)}`;
    const bodyText = replace(template.contentText, values);
    const bodyHtml = replaceInHtml(bodyFrom(template), values);
    const open = [
      ...openPlaceholder(subject),
      ...openPlaceholder(bodyText),
      ...openPlaceholder(bodyHtml),
    ];
    if (open.length > 0) throw new OpenPlaceholderError(open);
    const wording = this.marketingMail.wording(
      { subject, html: bodyHtml, text: bodyText, ...structureFrom(template) },
      unsubscribeLink,
    );

    const row = await this.prisma.mailDelivery.create({
      data: {
        companyId: entry.companyId,
        consentId: entry.id,
        templateId: template.id,
        recipientAddress: entry.email,
        channel: 'marketing',
        subject,
        contentSnapshot: wording.text,
        contentSnapshotHtml: wording.html,
        deliveryStatus: 'queued',
      },
      select: { id: true },
    });

    await this.audit.log({
      userId: user.id,
      actor: user.username,
      action: AUDIT_ACTION.broadcastTestSend,
      objectType: 'MailTemplate',
      objectId: template.id,
      afterValue: { deliveryId: row.id },
      ...source,
    });

    // Derselbe Weg wie jede andere Zeile — samt Prüfung beim Versand.
    const result = await this.sendOne(row.id);
    return result === 'sent'
      ? { sent: true }
      : { sent: false, reason: result };
  }

  // -------------------------------------------------------------- fortschritt

  /**
   * WIE WEIT IST DER VERSAND DIESER VORLAGE — als Zaehlwerte, sonst nichts.
   *
   * WARUM ES DAS GIBT: Der Lauf nimmt hoechstens `CONTROL_BROADCAST_PER_RUN`
   * Zeilen auf und laesst zwischen zwei Mails einige Sekunden vergehen. Bei
   * einem groesseren Verteiler dauert das ueber mehrere Laeufe hinweg Minuten,
   * und bis hierher gab es dazu keine Auskunft: Das Ergebnis eines Laufs kam
   * erst an seinem Ende und sagte nur etwas ueber diesen einen Lauf. Wer
   * zweihundert Adressen angeschrieben hat, sah eine Zeitansage und musste
   * hoffen.
   *
   * SIE FASST NICHTS AN. Reine Zaehlung ueber `MailVersand`; es gibt hier
   * keinen Schreibvorgang und keinen Weg, einen Lauf von hier aus anzustossen.
   *
   * EINE UNBEKANNTE VORLAGE IST EIN FEHLER, KEINE NULL. Vier Nullen zu einer
   * Kennung, die es nicht gibt, sind eine Auskunft ueber etwas, das nicht
   * existiert — und sie saehe genauso aus wie „alles versendet".
   */
  async progress(templateId: string): Promise<SendProgress> {
    // Wirft `VorlageNichtGefundenFehler`, wenn es die Vorlage nicht gibt.
    await this.templates.get(templateId);

    const groups = await this.prisma.mailDelivery.groupBy({
      by: ['deliveryStatus'],
      where: { templateId, channel: 'marketing' },
      _count: { _all: true },
    });

    const number = (status: DeliveryStatus): number =>
      groups.find((g) => g.deliveryStatus === status)?._count._all ?? 0;

    const open = number('queued') + number('sending');
    const sent = number('sent');
    const failed = number('failed');
    const refused = number('rejected');

    return {
      templateId,
      total: open + sent + failed + refused,
      sent,
      open,
      failed,
      refused,
    };
  }

  // ----------------------------------------------------------------- versand

  /**
   * Der Versandlauf. JEDE MINUTE, nicht öfter — der Abstand zwischen den
   * einzelnen Mails kommt zusätzlich aus `CONTROL_BROADCAST_INTERVAL_MS`.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'rundmail-versand' })
  async minutelyRun(): Promise<void> {
    if (this.config.get<string>('CONTROL_BROADCAST_ENABLED', 'ja') === 'nein') return;
    if (this.runs) return;
    this.runs = true;
    try {
      await this.executeSendRun();
    } catch (exception) {
      this.logger.error(
        `Versandlauf abgebrochen: ${
          exception instanceof Error ? exception.message : String(exception)
        }`,
      );
    } finally {
      this.runs = false;
    }
  }

  /**
   * Arbeitet die fälligen Zeilen ab. Öffentlich, damit sich der Lauf prüfen
   * und von Hand nachholen lässt — dieselbe Begründung wie beim Zeitplan.
   */
  async executeSendRun(
    atMost = Number(this.config.get<string>('CONTROL_BROADCAST_PER_RUN', '20')),
    intervalMs = Number(this.config.get<string>('CONTROL_BROADCAST_INTERVAL_MS', '5000')),
  ): Promise<SendRunResult> {
    const cleanedUp = await this.releasePending();

    const due = await this.prisma.mailDelivery.findMany({
      where: {
        channel: 'marketing',
        deliveryStatus: 'queued',
        OR: [
          { nextAttemptFrom: null },
          { nextAttemptFrom: { lte: new Date() } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: Math.max(1, atMost),
      select: { id: true },
    });

    const result: SendRunResult = {
      considered: due.length,
      sent: 0,
      refused: 0,
      retry: 0,
      failed: 0,
      cleanedUp,
    };

    for (const [number, row] of due.entries()) {
      // ABSTAND ZWISCHEN DEN MAILS, nicht davor: Der erste Versand soll nicht
      // unnötig warten, jeder weitere schon.
      if (number > 0 && intervalMs > 0) await wait(intervalMs);
      const outcome = await this.sendOne(row.id);
      if (outcome === 'sent') result.sent += 1;
      else if (outcome === 'rejected') result.refused += 1;
      else if (outcome === 'retry') result.retry += 1;
      else if (outcome === 'failed') result.failed += 1;
    }
    return result;
  }

  /**
   * Verschickt GENAU EINE Zeile.
   *
   * DIE ÜBERNAHME IST DER KERN. Sie läuft in einer Transaktion und nimmt zwei
   * Sperren in einer festen Reihenfolge:
   *
   *   1. die Einwilligungszeile (`WerbeFreigabe.pruefe`, `FOR UPDATE`)
   *   2. die Warteschlangenzeile (`FOR UPDATE`)
   *
   * `EinwilligungService.abmelden` nimmt dieselben Sperren in DERSELBEN
   * Reihenfolge. Deshalb kann kein Deadlock entstehen, und deshalb gibt es
   * kein Fenster zwischen „geprüft" und „übernommen": Wer widerruft, während
   * hier geprüft wird, wartet — und findet die Zeile danach entweder auf
   * `in_zustellung` (dann ist genau diese eine Mail schon unterwegs) oder auf
   * `in_warteschlange` (dann setzt er sie selbst auf `abgewiesen`).
   *
   * DER SMTP-AUFRUF STEHT AUSSERHALB DER TRANSAKTION. Eine Datenbanktransaktion
   * über einen Netzaufruf offen zu halten hielte Sperren über Sekunden.
   */
  async sendOne(
    deliveryId: string,
  ): Promise<'sent' | 'rejected' | 'retry' | 'failed' | 'nothing'> {
    const takeover = await this.apply(deliveryId);
    if (takeover.kind === 'nothing') return 'nothing';
    if (takeover.kind === 'rejected') return 'rejected';

    try {
      await this.marketingMail.send(
        takeover.approval,
        takeover.subject,
        takeover.wording,
        takeover.unsubscribeLink,
      );
    } catch (exception) {
      return this.recordFailure(deliveryId, takeover, exception);
    }

    await this.recordSuccess(deliveryId, takeover);
    return 'sent';
  }

  // ----------------------------------------------------------------- intern

  private async apply(deliveryId: string): Promise<Takeover> {
    const baseData = await this.prisma.mailDelivery.findUnique({
      where: { id: deliveryId },
      select: {
        consentId: true,
        deliveryStatus: true,
        subject: true,
        contentSnapshot: true,
        contentSnapshotHtml: true,
        errorCount: true,
      },
    });
    if (
      !baseData ||
      baseData.deliveryStatus !== 'queued' ||
      !baseData.consentId
    ) {
      // Ohne Einwilligungsbezug ist es keine werbliche Zeile dieses Moduls.
      // Sie wird hier nicht angefasst — der Transaktionskanal verschickt
      // selbst und trägt seine Zeilen selbst nach.
      return { kind: 'nothing' };
    }

    return this.prisma.$transaction(async (tx) => {
      // Reihenfolge der Sperren: erst Einwilligung, dann Versandzeile.
      const check = await MarketingApproval.check(tx, baseData.consentId!);
      await tx.$queryRaw`SELECT "id" FROM "MailDelivery" WHERE "id" = ${deliveryId} FOR UPDATE`;

      const now = await tx.mailDelivery.findUnique({
        where: { id: deliveryId },
        select: {
          deliveryStatus: true,
          subject: true,
          contentSnapshot: true,
          contentSnapshotHtml: true,
          errorCount: true,
        },
      });
      // Ein anderer Lauf war schneller.
      if (!now || now.deliveryStatus !== 'queued') {
        return { kind: 'nothing' } as Takeover;
      }

      if (!check.granted) {
        await tx.mailDelivery.update({
          where: { id: deliveryId },
          data: {
            deliveryStatus: 'rejected',
            lastErrorClass: check.reason,
            lastAttemptAt: new Date(),
            nextAttemptFrom: null,
          },
        });
        await this.audit.log(
          {
            userId: null,
            actor: 'versandlauf',
            action: AUDIT_ACTION.broadcastRefused,
            objectType: 'MailDelivery',
            objectId: deliveryId,
            afterValue: { reason: check.reason },
            ip: null,
            userAgent: null,
          },
          tx,
        );
        this.logger.warn(
          `Rundmail ${deliveryId} nicht versendet: ${check.reason}.`,
        );
        return { kind: 'rejected' } as Takeover;
      }

      await tx.mailDelivery.update({
        where: { id: deliveryId },
        data: { deliveryStatus: 'sending', lastAttemptAt: new Date() },
      });

      return {
        kind: 'versenden',
        approval: check.approval,
        subject: now.subject,
        // ZEILEN AUS DER ZEIT VOR DEM RAHMEN haben keinen HTML-Schnappschuss.
        // Sie bekommen einen aus ihrem Textteil gerahmt — der Textteil bleibt
        // dabei der gespeicherte, es wird nichts umgeschrieben.
        wording:
          now.contentSnapshotHtml === null
            ? {
                text: now.contentSnapshot,
                // OHNE die Strukturfelder der Vorlage: Der Schnappschuss ist
                // der Wortlaut, wie er damals hinausging. Eine Überschrift von
                // heute darüberzusetzen machte aus einem Nachweis eine
                // Behauptung.
                html: this.marketingMail.wording(
                  {
                    subject: now.subject,
                    html: htmlFromText(now.contentSnapshot),
                    text: now.contentSnapshot,
                  },
                  this.consents.unsubscribeLink(
                    check.approval.unsubscribeToken,
                  ),
                ).html,
              }
            : {
                text: now.contentSnapshot,
                html: now.contentSnapshotHtml,
              },
        unsubscribeLink: this.consents.unsubscribeLink(
          check.approval.unsubscribeToken,
        ),
        attempt: now.errorCount,
      } as Takeover;
    });
  }

  private async recordSuccess(
    deliveryId: string,
    takeover: Extract<Takeover, { kind: 'versenden' }>,
  ): Promise<void> {
    const tag = today();
    await this.prisma.$transaction(async (tx) => {
      await tx.mailDelivery.update({
        where: { id: deliveryId },
        data: {
          deliveryStatus: 'sent',
          sentAt: new Date(),
          lastAttemptAt: new Date(),
          lastErrorClass: null,
          nextAttemptFrom: null,
        },
      });
      // JEDE VERSENDETE MAIL ERSCHEINT IM VERLAUF DER ORGANISATION. Ohne den
      // Eintrag müsste jemand die Versandtabelle durchsuchen, um zu wissen,
      // was diese Organisation von uns bekommen hat.
      if (takeover.approval.companyId) {
        await writeSystemNote(
          tx,
          takeover.approval.companyId,
          `Rundmail versendet: „${takeover.subject}", ${dayReadable(tag)}`,
          tag,
        );
      }
      await this.audit.log(
        {
          userId: null,
          actor: 'versandlauf',
          action: AUDIT_ACTION.broadcastSent,
          objectType: 'MailDelivery',
          objectId: deliveryId,
          afterValue: { attempt: takeover.attempt + 1 },
          ip: null,
          userAgent: null,
        },
        tx,
      );
    });
  }

  private async recordFailure(
    deliveryId: string,
    takeover: Extract<Takeover, { kind: 'versenden' }>,
    exception: unknown,
  ): Promise<'retry' | 'failed'> {
    const errorClass: ErrorClass =
      exception instanceof MarketingMailError ? exception.errorClass : 'unknown';
    const attempts = takeover.attempt + 1;
    const retry =
      !WITHOUT_RETRY.includes(errorClass) && attempts < MAX_ATTEMPTS;

    await this.prisma.$transaction(async (tx) => {
      await tx.mailDelivery.update({
        where: { id: deliveryId },
        data: {
          deliveryStatus: retry ? 'queued' : 'failed',
          errorCount: attempts,
          lastErrorClass: errorClass,
          lastAttemptAt: new Date(),
          nextAttemptFrom: retry ? this.nextAttempt(attempts) : null,
        },
      });
      await this.audit.log(
        {
          userId: null,
          actor: 'versandlauf',
          action: AUDIT_ACTION.broadcastSendError,
          objectType: 'MailDelivery',
          objectId: deliveryId,
          afterValue: { errorClass, attempt: attempts, retry: retry },
          ip: null,
          userAgent: null,
        },
        tx,
      );
    });

    if (!retry) {
      await this.checkDeactivation(takeover.approval.email, takeover.approval.consentId);
    }
    return retry ? 'retry' : 'failed';
  }

  /**
   * DER ADRESSZÄHLER: drei erfolglose Zustellungen in Folge legen still.
   *
   * Gezählt wird über die Versandzeilen dieser Adresse rückwärts, beginnend
   * bei der jüngsten. Eine ERFOLGREICHE Zeile beendet die Zählung — das ist
   * die Umsetzung von „ein Erfolg dazwischen setzt den Zähler zurück". Ein
   * Fehlschlag, der unserem eigenen Postausgang anzulasten ist, zählt nicht
   * mit und unterbricht die Folge auch nicht: Er sagt über die Adresse nichts
   * aus.
   */
  private async checkDeactivation(
    email: string,
    consentId: string,
  ): Promise<void> {
    const rows = await this.prisma.mailDelivery.findMany({
      where: {
        recipientIdx: mailRecipientIndex(email),
        deliveryStatus: { in: ['sent', 'failed'] },
        lastAttemptAt: { not: null },
      },
      orderBy: [{ lastAttemptAt: 'desc' }, { createdAt: 'desc' }],
      take: 20,
      select: { deliveryStatus: true, lastErrorClass: true },
    });

    let inOutcome = 0;
    for (const row of rows) {
      if (row.deliveryStatus === 'sent') break;
      if (isRecipientRelated(row.lastErrorClass)) inOutcome += 1;
    }

    if (inOutcome < FAILED_ATTEMPTS_UNTIL_DEACTIVATION) return;
    await this.consents.deactivate(
      this.prisma,
      consentId,
      'hard_bounced',
      `${inOutcome} erfolglose Zustellversuche in Folge`,
    );
  }

  /**
   * Gibt Zeilen frei, die in `in_zustellung` hängengeblieben sind.
   *
   * Das passiert, wenn der Prozess mitten im SMTP-Aufruf endet. Sie werden
   * NICHT wieder in die Warteschlange gestellt: Ob die Mail hinausging, ist
   * nicht mehr feststellbar, und ein zweiter Versuch verschickte sie
   * möglicherweise doppelt. Sie werden als `fehlgeschlagen` mit der Klasse
   * `abgebrochen` vermerkt — sichtbar, nachlesbar, und ohne Folgen für die
   * Adresse (`abgebrochen` steht nicht in `EMPFAENGERBEZOGENE_KLASSEN`).
   */
  private async releasePending(): Promise<number> {
    const limit = new Date(Date.now() - 30 * 60 * 1000);
    const { count } = await this.prisma.mailDelivery.updateMany({
      where: {
        deliveryStatus: 'sending',
        lastAttemptAt: { lt: limit },
      },
      // `abgebrochen` steht nicht in `EMPFAENGERBEZOGENE_KLASSEN` und zählt
      // deshalb nicht gegen die Adresse — es sagt nichts über sie aus.
      data: { deliveryStatus: 'failed', lastErrorClass: 'abgebrochen' },
    });
    if (count > 0) {
      this.logger.warn(
        `${count} Versandzeilen hingen in „in_zustellung" und wurden als ` +
          'abgebrochen vermerkt. Ob sie hinausgingen, ist nicht feststellbar.',
      );
    }
    return count;
  }

  private nextAttempt(attempt: number): Date {
    const minutes = Number(
      this.config.get<string>('CONTROL_BROADCAST_RETRY_MINUTES', '15'),
    );
    return new Date(Date.now() + minutes * attempt * 60 * 1000);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Der HTML-Rumpf einer Vorlage.
 *
 * `inhaltHtml` ist die Fassung aus dem Redaktionsfeld und bereits gesäubert
 * (`VorlageService`). Fehlt sie, stammt die Vorlage aus der Zeit vor dem
 * Redaktionsfeld: Dann wird der reine Text in Absätze gesetzt. Das ist keine
 * Umdeutung — es ist dieselbe Nachricht, nur mit Absatzgrenzen statt
 * Leerzeilen.
 */
/**
 * Ein Bestätigungszeitpunkt als lesbares Tagesdatum, oder `undefined`.
 *
 * NUR DER TAG, nicht die Uhrzeit: In der Fusszeile steht eine fachliche
 * Angabe („am 03.03.2026 eingewilligt"), keine technische. Der Zeitstempel
 * mit Minute bleibt am Eintrag und im Nachweis, wo er hingehört.
 */
function tagFrom(timestamp: Date | null): string | undefined {
  if (timestamp === null) return undefined;
  return timestamp.toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function bodyFrom(template: { contentText: string; contentHtml: string | null }): string {
  return template.contentHtml ?? htmlFromText(template.contentText);
}

/**
 * Die vier Strukturfelder einer Vorlage, so wie der Rahmen sie erwartet.
 *
 * SIE LAUFEN NICHT DURCH DIE PLATZHALTERERSETZUNG, und das ist Absicht:
 * Überschrift und Knopf sind Struktur, kein personalisierter Text. Ein
 * Platzhalter im Knopfziel wäre ausserdem ein Weg, aus einem Datensatz eine
 * Adresse in einen Link zu bauen — genau das, was die strenge Prüfung des
 * Ziels verhindern soll.
 */
function structureFrom(template: {
  eyebrow: string | null;
  heading: string | null;
  buttonText: string | null;
  buttonTarget: string | null;
}) {
  return {
    eyebrow: template.eyebrow,
    heading: template.heading,
    buttonText: template.buttonText,
    buttonTarget: template.buttonTarget,
  };
}
