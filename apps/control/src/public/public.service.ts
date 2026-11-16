import { Injectable, Logger } from '@nestjs/common';
import type { InquiryOutcome } from '.prisma/control-client';
import { quotaParts, type QuotaParts } from './quota-key';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { companyContactEmailIndex } from '../crypto/field-crypto';
import { today, mailBrand, toDate } from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import type { InquirySource } from '../common/inquiry-source';
import { companyUrl } from '../common/base-url';
import { dayReadable } from '../common/calendar';
import { registeredMailDefaults } from '../mail/sender';
import { DEMO_SUBJECT, MailService, PILOT_SUBJECT } from '../mail/mail.service';
import { writeSystemNote } from '../notes/system-note';
import { detail } from './foreign-text';
import type { DbClient } from '../prisma/db-client';
import { PrismaService } from '../prisma/prisma.service';
import type { InquiryKind, PublicInquiryDto } from './dto/inquiry.dto';
import { ConsentService } from '../consent/consent.service';

/** Nach außen sieht JEDER Ausgang gleich aus. Siehe `anfrage()`. */
export interface InquiryResponse {
  ok: true;
}

const RESPONSE: InquiryResponse = { ok: true };

/** Wie viele Demo-Zugangsmails eine Adresse im Zeitraum bekommen darf ([W2]). */
export const DEMO_QUOTA = 1;

/** Zeitraum des Kontingents in Tagen. */
export const DEMO_QUOTA_DAYS = 30;

/**
 * Wie viele Eingangsbestätigungen einer Pilotanfrage eine Adresse bekommen
 * darf — DERSELBE Riegel wie bei der Demo und aus demselben Grund ([W2]).
 *
 * Zwei statt einer: Anders als der Demo-Zugang ist die Bestätigung an eine
 * fortlaufende Bearbeitung geknüpft, und eine Organisation, die ein halbes
 * Jahr später ein zweites Mal anfragt, soll nicht ins Schweigen laufen. Der
 * Verstärkereffekt, gegen den der Riegel sich richtet, braucht Dutzende
 * Zustellungen — nicht zwei.
 */
export const PILOT_QUOTA = 2;

/** Ergebnisse, nach denen eine Art für die Organisation als erledigt gilt. */
const FULFILLED: readonly InquiryOutcome[] = ['credentials_sent', 'confirmation_sent'];


@Injectable()
export class PublicService {
  private readonly logger = new Logger(PublicService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly consents: ConsentService,
  ) {}

  /**
   * Nimmt eine Anfrage von der Webseite entgegen.
   *
   * DREI EIGENSCHAFTEN, die zusammengehören:
   *
   * 1. KEIN AUFZÄHLUNGSKANAL. Die Antwort ist immer dieselbe — bei einer neuen
   *    Organisation, bei einer bereits bekannten Adresse, bei einem
   *    Honeypot-Treffer und bei gescheitertem Mailversand. Wer sonst eine
   *    Adresse einträgt und aus der Antwort abliest, ob sie schon Kundin ist,
   *    hätte ein Kundenverzeichnis auf Zuruf.
   * 2. KEINE DUBLETTE. Zu einer schon bekannten Adresse entsteht keine zweite
   *    Organisation, sondern eine Notiz an der bestehenden.
   * 3. DIE ANFRAGE GEHT NICHT VERLOREN. Erst wird gespeichert, dann verschickt.
   *    Scheitert der Versand, bleibt die Organisation stehen und der Fehler
   *    wird gemeldet (Log, Audit-Log, `GET /api/zugang/postausgang`).
   */
  async inquiry(
    dto: PublicInquiryDto,
    source: InquirySource,
  ): Promise<InquiryResponse> {
    if (dto.website !== undefined && dto.website.trim() !== '') {
      // Honeypot: nach außen dieselbe Antwort, aber nichts angelegt und nichts
      // verschickt. Der Nachweis bleibt, damit sich Wellen erkennen lassen.
      this.logger.warn('Anfrage mit ausgefülltem Honeypot verworfen.');
      await this.audit.log({
        userId: null,
        actor: 'form',
        action: AUDIT_ACTION.publicInquiryDiscarded,
        objectType: 'Inquiry',
        objectId: null,
        afterValue: { reason: 'honeypot', inquiryKind: dto.inquiryKind },
        ...source,
      });
      return RESPONSE;
    }

    const email = dto.email.trim();
    const result = await this.create(dto, email, source);
    // ERST AUSLÖSEN, DANN BENACHRICHTIGEN: Die Mail an die Betreiberin sagt,
    // was tatsächlich passiert ist – und das steht erst danach fest.
    const outcome = await this.triggerFrom(dto, email, result);
    await this.recordFixed(result.companyId, dto.inquiryKind, outcome);
    await this.notify(dto, email, result, outcome);
    await this.carriesIfWanted(dto, email, result, source);
    return RESPONSE;
  }

  /**
   * =====================================================================
   * DIE EINWILLIGUNG AUS DEM ANFRAGEFORMULAR
   * =====================================================================
   *
   * SIE LÄUFT NACH DER ANFRAGE UND UNABHÄNGIG VON IHR. Scheitert sie,
   * bleibt die Anfrage bestehen — sie ist der Grund, aus dem jemand das
   * Formular abgeschickt hat, und ein Fehler in der Kür darf die Pflicht
   * nicht mitreissen.
   *
   * SIE ERZEUGT EINE UNBESTÄTIGTE EINWILLIGUNG plus eine
   * Bestätigungsmail — nie eine bestätigte. Dass jemand seine eigene
   * Adresse eingetragen hat, beweist erst der Klick im Postfach; alles
   * davor ist eine Behauptung, die jeder über jede fremde Adresse
   * aufstellen könnte.
   *
   * DER WORTLAUT KOMMT AUS DEM FORMULAR. Nur dort steht, was tatsächlich
   * neben dem Häkchen zu lesen war.
   *
   * KEIN HÄKCHEN, KEIN EINTRAG — und auch keine Mail. Ein fehlendes Feld
   * ist ein „nein", kein „vielleicht".
   */
  private async carriesIfWanted(
    dto: PublicInquiryDto,
    email: string,
    result: { companyId: string | null },
    source: InquirySource,
  ): Promise<void> {
    if (dto.newsletter !== true) return;
    const wording = dto.newsletterWording?.trim() ?? '';
    if (wording === '') return;

    try {
      await this.consents.subscribe(
        {
          email,
          formText: wording,
          origin: 'webseite-anfrageformular',
          ...(result.companyId === null
            ? {}
            : { companyId: result.companyId }),
        },
        source,
      );
    } catch (error) {
      // LAUT, ABER NICHT TÖDLICH. Die Anfrage steht; die Einwilligung
      // fehlt. Das ist genau der Fall, in dem jemand später fragt, warum
      // keine Rundmail ankommt — er gehört ins Log, nicht ins Schweigen.
      this.logger.error(
        `Einwilligung aus dem Anfrageformular scheiterte (Organisation ` +
          `${result.companyId ?? 'ohne'}): ` +
          `${error instanceof Error ? error.message : 'unknown'}. ` +
          'Die Anfrage selbst ist gespeichert.',
      );
    }
  }

  /**
   * Legt die Organisation an — oder hängt eine Notiz an die bestehende.
   *
   * DER ENGPASS IST DIE SPERRE AUF DER ADRESSE. Ohne sie sähen zwei
   * gleichzeitige Anfragen mit derselben E-Mail beide „gibt es noch nicht" und
   * legten zwei Organisationen an. Ein `@@unique` auf
   * `ansprechpartnerinEmail` gäbe es dafür nicht her — die Adresse ist ein
   * Kontaktfeld und darf leer und doppelt sein (zwei Organisationen können
   * dieselbe Person haben, die von Hand eingetragen wird). Deshalb eine
   * Beratungssperre auf einem aus der Adresse abgeleiteten Schlüssel: sie gilt
   * nur für die Dauer der Transaktion und nur für genau diese Adresse.
   */
  private async create(
    dto: PublicInquiryDto,
    email: string,
    source: InquirySource,
  ): Promise<{ companyId: string; incoming: boolean }> {
    const tag = today();
    const block = lockKeyFor(email);

    return this.prisma.$transaction(async (tx) => {
      // `$executeRaw` und nicht `$queryRaw`: die Sperrfunktion liefert `void`
      // zurück, und daran scheitert die Ergebnisumwandlung von Prisma.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${block})`;

      const present = await tx.company.findFirst({
        where: { contactEmailIdx: companyContactEmailIndex(email) },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });

      if (present) {
        // ZWEI Notizen, und die Trennung ist der Kern von [K1]: Die
        // systemerzeugte enthaelt AUSSCHLIESSLICH vom System verfasste Woerter
        // und ist deshalb unveraenderlich; alles, was ein Unbeteiligter
        // geschickt hat, steht in einer zweiten, die die Betreiberin
        // richtigstellen und loeschen kann.
        await writeSystemNote(
          tx,
          present.id,
          systemRow(dto.inquiryKind, tag, true, dto.terms === true),
          tag,
        );
        await writeForeignNote(tx, present.id, dto, email, tag);
        await this.audit.log(
          {
            userId: null,
            actor: 'form',
            action: AUDIT_ACTION.publicInquiryDuplicate,
            objectType: 'Company',
            objectId: present.id,
            afterValue: { inquiryKind: dto.inquiryKind, ...termsEvidence(dto) },
            ...source,
          },
          tx,
        );
        return { companyId: present.id, incoming: false };
      }

      const created = await tx.company.create({
        data: {
          // WARUM NICHT EINFACH DIE ADRESSE. Eine Organisation, deren Name
          // die E-Mail-Adresse IST, sieht in jeder Liste wie ein gepflegter
          // Datensatz aus — und die Adresse steht dort ohnehin schon in der
          // Kontaktspalte. Das Praefix sagt, dass hier noch ein Name fehlt,
          // und sortiert die vorlaeufigen Eintraege zusammen.
          //
          // Die Adresse bleibt trotzdem darin: Sie ist bei einer Demo-Anfrage
          // ohne Organisationsfeld die EINZIGE Angabe, die zwei Anfragen
          // unterscheidbar macht. Beim Loeschen der Kontaktdaten wird der Name
          // mit ueberschrieben — sonst waere sie hier eine Kopie ausserhalb
          // jeder Auskunft.
          name:
            dto.company?.trim() ||
            dto.name?.trim() ||
            `Anfrage von ${email}`,
          status: 'inquiry',
          source: 'form',
          contactName: dto.name?.trim() || null,
          contactEmail: email,
          contactPhone: dto.phone?.trim() || null,
          // DER GEWÜNSCHTE RHYTHMUS, und die daraus folgende Zahlungsart.
          //
          // „Monatlich per Lastschrift" ist keine Auslegung, sondern die
          // Zusage der Webseite. Sie hier gleich mitzuschreiben spart der
          // Betreiberin einen Schritt — und `pruefeZahlungspaarung` wiese
          // eine andere Kombination ohnehin ab.
          //
          // BEI HALBJÄHRLICH UND JÄHRLICH BLEIBT DIE ART OFFEN: Dort ist
          // beides möglich, und das Formular fragt es nicht. Sie zu raten
          // wäre eine Behauptung über eine Entscheidung, die niemand
          // getroffen hat.
          ...(dto.paymentInterval === undefined
            ? {}
            : {
                paymentInterval: dto.paymentInterval,
                ...(dto.paymentInterval === 'monthly'
                  ? { paymentMethod: 'direct_debit' as const }
                  : {}),
              }),
        },
        select: { id: true, name: true },
      });
      await writeSystemNote(
        tx,
        created.id,
        systemRow(dto.inquiryKind, tag, false, dto.terms === true),
        tag,
      );
      await writeForeignNote(tx, created.id, dto, email, tag);
      await this.audit.log(
        {
          userId: null,
          actor: 'form',
          action: AUDIT_ACTION.publicInquiryReceived,
          objectType: 'Company',
          objectId: created.id,
          beforeValue: null,
          afterValue: {
            name: created.name,
            status: 'inquiry',
            source: 'form',
            inquiryKind: dto.inquiryKind,
            ...termsEvidence(dto),
          },
          ...source,
        },
        tx,
      );
      return { companyId: created.id, incoming: true };
    });
  }

  /**
   * =====================================================================
   * JE ART GENAU EINMAL PRO ORGANISATION (15.09.2026)
   * =====================================================================
   *
   * Wer Pilotphase UND Demo anfragt, bekommt beides – auch mit derselben
   * Adresse, also an derselben Organisation. Vorher verschickte eine
   * Demo-Anfrage zu einer bekannten Adresse gar nichts („Dublette"), selbst
   * wenn davor nur eine Pilot-Anfrage kam. Gemeldet am 15.09.2026: Eine
   * Organisation fragte erst die Pilotphase an, dann zweimal die Demo, und
   * bekam nie Zugangsdaten.
   *
   * Die Regel steht jetzt an der ART, nicht an der Adresse: Ist dieselbe Art
   * für diese Organisation schon ERFÜLLT (Mail hinausgegangen), geht nichts
   * erneut hinaus. Ist sie gescheitert oder nie erfasst worden, wird erneut
   * ausgelöst. Das Kontingent je Adresse ([W2]) bleibt als zweite Grenze
   * gegen Missbrauch mit fremden Adressen.
   */
  private async triggerFrom(
    dto: PublicInquiryDto,
    email: string,
    result: { companyId: string },
  ): Promise<InquiryOutcome> {
    const alreadyFulfilled = await this.prisma.inquiry.count({
      where: {
        companyId: result.companyId,
        kind: dto.inquiryKind,
        outcome: { in: [...FULFILLED] },
      },
    });
    if (alreadyFulfilled > 0) {
      this.logger.log(
        `${dto.inquiryKind === 'demo' ? 'Demo' : 'Pilot'}-Anfrage zu Organisation ` +
          `${result.companyId}: für diese Art schon erfüllt – nichts erneut.`,
      );
      return 'already_triggered';
    }
    return dto.inquiryKind === 'demo'
      ? this.demoAccess(email, result)
      : this.pilotConfirmation(email, result);
  }

  /**
   * Hält fest, was angefragt wurde und was darauf passierte.
   *
   * SCHEITERT ES, GEHT DIE ANFRAGE NICHT VERLOREN: Sie steht als Organisation
   * und Notiz schon in der Datenbank. Nur die Auswertung fehlt dann – das
   * gehört laut ins Log, darf aber die Benachrichtigung nicht verhindern.
   */
  private async recordFixed(
    companyId: string,
    kind: InquiryKind,
    outcome: InquiryOutcome,
  ): Promise<void> {
    try {
      await this.prisma.inquiry.create({ data: { companyId, kind, outcome } });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Anfrage (${kind}, ${outcome}) zu Organisation ${companyId} ließ sich ` +
          `nicht festhalten: ${reason}`,
      );
    }
  }

  /**
   * Verschickt die Betreiber-Benachrichtigung – mit dem, was `loeseAus`
   * tatsächlich getan hat.
   *
   * LÄUFT NACH DEM SPEICHERN UND AUSSERHALB DER TRANSAKTION. Ein hängender
   * SMTP-Server soll keine Datenbanktransaktion offen halten, und ein
   * gescheiterter Versand darf die bereits angelegte Anfrage nicht
   * zurückrollen. Jeder Fehlschlag wird einzeln gefangen: geht die
   * Betreibermail nicht hinaus, wird die Demo-Mail trotzdem versucht.
   */
  private async notify(
    dto: PublicInquiryDto,
    email: string,
    result: { companyId: string; incoming: boolean },
    outcome: InquiryOutcome,
  ): Promise<void> {
    const { companyId } = result;
    // Ziel des Anfrageweges: Umgebung vor Manifest (`mail.inquiryTo`).
    const recipient = (
      this.config.get<string>('CONTROL_INQUIRY_RECIPIENT') ??
      registeredMailDefaults()?.inquiryTo ??
      ''
    ).trim();

    if (recipient === '') {
      // KEIN Abbruch: die Anfrage steht bereits in der Datenbank, und sie
      // wegen einer fehlenden Umgebungsvariablen zu verlieren, wäre genau der
      // Schaden, den die Benachrichtigung verhindern soll.
      this.logger.error(
        'CONTROL_INQUIRY_RECIPIENT (oder mail.inquiryTo im Manifest) ist nicht gesetzt — es ging KEINE ' +
          'Benachrichtigung hinaus. Die Anfrage steht in der Datenbank ' +
          `(Organisation ${companyId}).`,
      );
      await this.reportMailError(companyId, 'benachrichtigung', 'nicht_konfiguriert');
    } else {
      await this.attempts(companyId, 'benachrichtigung', () =>
        this.mail.sendInquiryNotification(
          recipient,
          subjectFor(dto.inquiryKind, dto.company, outcome),
          notificationRows(
            dto,
            email,
            companyId,
            companyUrl(this.config, companyId),
            outcome,
          ),
        ),
      );
    }

  }

  /**
   * Automatischer Versand der Demo-Zugangsdaten — MIT KONTINGENT ([W2]).
   *
   * Der Versand bleibt, er ist der Grund, warum eine Demo-Anfrage auch nachts
   * sofort beantwortet ist. Aber er ging bisher an JEDE Adresse, so oft man
   * wollte, ohne dass die Inhaberin der Adresse je zugestimmt hätte. Damit war
   * die Route ein Verstärker für unaufgeforderte Post: Wer eine fremde Adresse
   * einträgt, lässt das Produkt dort zustellen (§ 7 UWG).
   *
   * Zwei Riegel, die zusammen greifen:
   * 1. NUR BEI EINER NEUEN ORGANISATION. Eine Wiederholung mit derselben
   *    Adresse ist eine Dublette und löst gar keinen Versand mehr aus.
   * 2. HÖCHSTENS `DEMO_KONTINGENT` je Adresse in `DEMO_KONTINGENT_TAGE`.
   *    Das greift auch dann, wenn die Organisation dazwischen gelöscht oder
   *    ihre Adresse geändert wurde — der Zähler hängt an der Adresse, nicht am
   *    Datensatz.
   *
   * Gezählt wird über `MailVersand`; die Tabelle ist ohnehin für den
   * Versandnachweis da.
   */
  /**
   * Zählt Mails EINES Betreffs an DASSELBE Postfach — Schlüssel in SQL.
   *
   * NICHT AUF DIE ZEICHENKETTE GENAU ([A.14]): `opfer+1@`, `opfer+2@` waren
   * je eine eigene Adresse und holten sich je ein frisches Kontingent.
   * Gezählt wird gegen den Kontingent-Schlüssel (kontingent-schluessel.ts).
   *
   * UND ZWAR IN DER DATENBANK ([Review A1]). Die erste Fassung wählte nach
   * Domäne vor (`take: 500`) und zählte in der Anwendung — ein füllbares
   * Fenster: 500 Anfragen mit `f1@…f500@` derselben Domäne schoben das Opfer
   * hinaus, und die Plus-Varianten lösten wieder je eine Mail aus. Kein
   * festes Fenster über einer domänenweiten Vorauswahl ist dagegen sicher.
   * Deshalb baut die Abfrage den Schlüssel Schritt für Schritt nach, ohne
   * Obergrenze.
   *
   * DER BETREFF IST DER ZÄHLKREIS. Demo-Zugang und Eingangsbestätigung
   * dürfen sich nicht gegenseitig verbrauchen; deshalb hat jede Mailart eine
   * eigene Betreffkonstante, und deshalb sind diese Konstanten unveränderlich
   * (`DEMO_BETREFF`, `PILOT_BETREFF`). Wer einen Betreff umformuliert, setzt
   * den Zähler für alle bisherigen Zeilen auf null.
   *
   * Die Adresse steht in `MailVersand` so, wie sie eingegeben wurde. Die
   * Normalisierung wird deshalb in der Abfrage nachgebaut:
   *   1. Rand-Leerzeichen weg, Kleinschreibung.
   *   2. Domäne = Teil nach dem `@`, verglichen mit allen Schreibweisen
   *      (googlemail.com und gmail.com sind dasselbe Postfach).
   *   3. Lokaler Teil = Teil vor dem `@`, abgeschnitten am ersten `+`, das
   *      nicht an erster Stelle steht.
   *   4. Bei Gmail zusätzlich ohne Punkte.
   * Jeder Schritt entspricht einer Zeile in `kontingentTeile`; wer dort etwas
   * ändert, muss es hier nachziehen — `kontingent.integration.spec.ts` hält
   * beide Seiten gegeneinander.
   */
  private async countSend(
    subject: string,
    parts: QuotaParts,
    since: Date,
  ): Promise<number> {
    // Betreff und Adresse sind verschluesselt; die Datenbank kann sie weder
    // vergleichen noch zerlegen. Deshalb werden ALLE Zeilen des Zeitfensters
    // (ohne Obergrenze, [Review A1]) geladen, entschluesselt und hier nach
    // demselben Schluessel gezaehlt. Nur die beiden noetigen Spalten werden
    // gelesen.
    const rows = await this.prisma.mailDelivery.findMany({
      where: { createdAt: { gte: since } },
      select: { subject: true, recipientAddress: true },
    });
    let count = 0;
    for (const row of rows) {
      if (row.subject !== subject) continue;
      const other = quotaParts(row.recipientAddress);
      if (other === null) continue;
      if (
        other.domain === parts.domain &&
        other.local === parts.local
      ) {
        count += 1;
      }
    }
    return count;
  }

  private async demoAccess(
    email: string,
    result: { companyId: string },
  ): Promise<InquiryOutcome> {
    // Der frühere „zweite Riegel" (keine Zugangsdaten an eine bekannte
    // Adresse) ist entfallen: Er verhinderte auch die ERSTE Demo-Mail, wenn
    // vorher eine Pilot-Anfrage kam. Wiederholungen fängt jetzt `loeseAus`
    // an der Art ab, fremde Adressen weiterhin das Kontingent.
    return this.withQuota({
      email,
      companyId: result.companyId,
      subject: DEMO_SUBJECT,
      quota: DEMO_QUOTA,
      purpose: 'demo_zugang',
      reason: 'demo_kontingent',
      // BEWUSST OHNE die Zugangsdaten: Der Nachweis soll belegen, DASS die
      // Standardmail hinausging, und kein Passwort in der Datenbank ablegen
      // ([H4]). Der Wortlaut steht im Quelltext von `MailService`.
      snapshot:
        'Standardtext „Demo-Zugangsdaten" (Zugangsdaten aus der Umgebung, ' +
        'hier nicht gespeichert).',
      success: 'credentials_sent',
      send: () => this.mail.sendDemoAccess(email),
    });
  }

  /**
   * Eingangsbestätigung einer Pilotanfrage an die Anfragenden.
   *
   * KEIN `neu`-RIEGEL wie beim Demo-Zugang. Der ist dort die Antwort auf ein
   * Passwort im Mailtext; hier steht nichts drin, was jemand haben will.
   * Eine Organisation, die nach einem halben Jahr erneut anfragt, ins
   * Schweigen laufen zu lassen, wäre der grössere Schaden. Der Riegel ist
   * das Kontingent, und das zählt an der Adresse — nicht am Datensatz, den
   * jemand zwischendurch gelöscht haben kann.
   */
  private async pilotConfirmation(
    email: string,
    result: { companyId: string },
  ): Promise<InquiryOutcome> {
    return this.withQuota({
      email,
      companyId: result.companyId,
      subject: PILOT_SUBJECT,
      quota: PILOT_QUOTA,
      purpose: 'anfrage_bestaetigung',
      reason: 'pilot_kontingent',
      snapshot: 'Standardtext „Eingangsbestätigung Pilotanfrage".',
      success: 'confirmation_sent',
      send: () => this.mail.sendInquiryConfirmation(email),
    });
  }

  /**
   * Verschickt eine automatische Mail an eine SELBST EINGETRAGENE Adresse —
   * aber nur, solange das Kontingent es hergibt, und schreibt danach den
   * Nachweis.
   *
   * Der gemeinsame Rumpf von Demo-Zugang und Eingangsbestätigung. Zwei
   * Abschriften wären zwei Stellen, an denen der Riegel fehlen kann, und die
   * zweite fällt niemandem auf — dieselbe Überlegung wie bei `transport.ts`.
   *
   * GEZÄHLT WIRD ÜBER `MailVersand`, gegen den Kontingent-Schlüssel und in
   * der Datenbank. Warum nicht auf die Zeichenkette genau ([A.14]) und warum
   * nicht in der Anwendung ([Review A1]), steht bei `zaehleVersand`.
   */
  private async withQuota(job: {
    email: string;
    companyId: string;
    subject: string;
    quota: number;
    purpose: string;
    reason: string;
    snapshot: string;
    /** Was als Ergebnis gilt, wenn die Mail hinausging. */
    success: InquiryOutcome;
    send: () => Promise<void>;
  }): Promise<InquiryOutcome> {
    const since = new Date(
      Date.now() - DEMO_QUOTA_DAYS * 24 * 60 * 60 * 1000,
    );
    const parts = quotaParts(job.email);
    const alreadySent =
      parts === null
        ? 0
        : await this.countSend(job.subject, parts, since);
    if (alreadySent >= job.quota) {
      this.logger.warn(
        `Kontingent für „${job.purpose}" ausgeschöpft ` +
          `(${job.quota} in ${DEMO_QUOTA_DAYS} Tagen). ` +
          'Es geht nichts hinaus.',
      );
      await this.audit.log({
        userId: null,
        actor: 'form',
        action: AUDIT_ACTION.publicInquiryDiscarded,
        objectType: 'Company',
        objectId: job.companyId,
        afterValue: { reason: job.reason, purpose: job.purpose },
      });
      return 'quota_exhausted';
    }

    let sent = false;
    await this.attempts(job.companyId, job.purpose, async () => {
      await job.send();
      sent = true;
    });
    if (!sent) return 'send_failed';

    await this.prisma.mailDelivery.create({
      data: {
        companyId: job.companyId,
        recipientAddress: job.email,
        channel: 'transactional',
        subject: job.subject,
        contentSnapshot: job.snapshot,
        sentAt: new Date(),
        deliveryStatus: 'sent',
      },
    });
    return job.success;
  }

  /** Führt einen Versand aus und meldet den Fehlschlag, ohne ihn zu werfen. */
  private async attempts(
    companyId: string,
    purpose: string,
    send: () => Promise<void>,
  ): Promise<void> {
    try {
      await send();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Anfrage-Mail (${purpose}) zu Organisation ${companyId} ging nicht ` +
          `hinaus: ${reason}. Die Anfrage selbst ist gespeichert.`,
      );
      await this.reportMailError(companyId, purpose, 'send_failed');
    }
  }

  /**
   * Schreibt den Fehlschlag ins Audit-Log.
   *
   * OHNE den Wortlaut der Relay-Meldung: darin steht bei einer Empfängerabsage
   * die Zieladresse im Klartext. Der volle Wortlaut steht im Anwendungslog,
   * die Klasse unter `GET /api/zugang/postausgang`.
   */
  private async reportMailError(
    companyId: string,
    purpose: string,
    reason: string,
  ): Promise<void> {
    await this.audit.log({
      userId: null,
      actor: 'form',
      action: AUDIT_ACTION.publicInquiryMailError,
      objectType: 'Company',
      objectId: companyId,
      afterValue: { purpose, reason },
    });
  }
}

/**
 * Schreibt die übermittelten Angaben als NICHT-systemerzeugte Notiz.
 *
 * `vomSystem: false` ist hier die eigentliche Aussage und keine Nachlässigkeit:
 * Diese Zeilen hat das System NICHT verfasst. Genau deshalb darf und muss die
 * Betreiberin sie ändern und löschen können — und genau deshalb sind sie auch
 * das, was die Kontaktdatenlöschung entfernt.
 */
async function writeForeignNote(
  db: DbClient,
  companyId: string,
  dto: PublicInquiryDto,
  email: string,
  tag: string,
): Promise<void> {
  const text = submittedDetails(dto, email);
  if (text === null) return;
  await db.note.create({
    data: { companyId, date: toDate(tag), text, bySystem: false },
  });
}

/**
 * Ein stabiler 64-Bit-Schlüssel für die Beratungssperre, abgeleitet aus der
 * kleingeschriebenen Adresse.
 *
 * Bewusst in JavaScript gerechnet und nicht mit `hashtext()` in Postgres:
 * `hashtext` ist eine interne Funktion ohne Bestandsgarantie, dieser
 * Schlüssel dagegen ist über Datenbankversionen hinweg derselbe.
 */
export function lockKeyFor(email: string): bigint {
  const sum = createHash('sha256')
    .update(email.trim().toLowerCase(), 'utf8')
    .digest('hex');
  return BigInt.asIntN(64, BigInt(`0x${sum.slice(0, 16)}`));
}

/** Betreff der Betreiber-Benachrichtigung. */
export function subjectFor(
  kind: InquiryKind,
  company?: string,
  outcome?: InquiryOutcome,
): string {
  const subject =
    kind === 'demo'
      ? 'Neue Demo-Anfrage'
      : `Pilotphase-Anfrage – ${company ?? 'ohne Organisationsangabe'}`;
  // Ging nichts hinaus, muss die Betreiberin handeln – das soll schon in der
  // Postfachliste stehen, nicht erst im Text.
  return outcome === 'quota_exhausted' || outcome === 'send_failed'
    ? `${subject} – bitte von Hand antworten`
    : subject;
}

/**
 * Der Einleitungssatz — er sagt in einer Zeile, was passiert ist.
 *
 * Vorher begann die Mail unvermittelt mit „Organisation: …". Wer sie auf dem
 * Telefon sieht, liest zuerst den Vorschautext, und der war damit eine
 * Feldüberschrift. Ein Satz beantwortet die Frage, wegen der man die Mail
 * überhaupt öffnet.
 */
function introductionFor(kind: InquiryKind, outcome: InquiryOutcome): string {
  // DER SATZ SAGT, WAS WIRKLICH PASSIERT IST. Vorher stand bei jeder
  // Demo-Anfrage „Sie sind bereits automatisch hinausgegangen" – auch dann,
  // wenn nichts hinausging (gemeldet am 15.09.2026).
  if (kind === 'demo') {
    switch (outcome) {
      case 'credentials_sent':
        return (
          `Eine Organisation interessiert sich für ${mailBrand().name} und hat die ` +
          'Zugangsdaten zur Demo angefordert. Sie sind automatisch ' +
          'hinausgegangen – hier stehen die Angaben aus dem Formular.'
        );
      case 'already_triggered':
        return (
          'Eine Organisation hat die Zugangsdaten zur Demo erneut angefordert. ' +
          'Sie hatte sie schon einmal bekommen, deshalb ging diesmal nichts ' +
          'hinaus. Falls sie nicht angekommen sind, bitte von Hand schicken.'
        );
      case 'quota_exhausted':
        return (
          'Eine Organisation hat die Zugangsdaten zur Demo angefordert. Sie ' +
          'gingen NICHT hinaus: An diese Adresse sind in den letzten 30 Tagen ' +
          'schon Zugangsdaten gegangen (Schutzgrenze). Bitte bei Bedarf von ' +
          'Hand schicken.'
        );
      default:
        return (
          'Eine Organisation hat die Zugangsdaten zur Demo angefordert. Der ' +
          'Versand ist GESCHEITERT – bitte die Zugangsdaten von Hand schicken.'
        );
    }
  }
  switch (outcome) {
    case 'confirmation_sent':
      return (
        `Eine Organisation interessiert sich für die Pilotphase von ${mailBrand().name} ` +
        'und hat sich dazu gemeldet. Sie hat eine Eingangsbestätigung ' +
        'bekommen; eine Antwort steht noch aus.'
      );
    case 'already_triggered':
      return (
        'Eine Organisation hat sich erneut zur Pilotphase gemeldet. Die ' +
        'Eingangsbestätigung hatte sie schon bekommen; eine Antwort steht noch ' +
        'aus.'
      );
    case 'quota_exhausted':
      return (
        'Eine Organisation hat sich zur Pilotphase gemeldet. Die ' +
        'Eingangsbestätigung ging NICHT hinaus (Schutzgrenze für diese Adresse ' +
        'erreicht) – bitte selbst antworten.'
      );
    default:
      return (
        'Eine Organisation hat sich zur Pilotphase gemeldet. Die ' +
        'Eingangsbestätigung ist GESCHEITERT – bitte selbst antworten.'
      );
  }
}

/**
 * Inhalt der Betreiber-Benachrichtigung.
 *
 * DREI TEILE, durch Leerzeilen getrennt: der Einleitungssatz, die
 * übermittelten Angaben, die Handlungsanweisung. Die Leerzeilen sind nicht
 * Kosmetik — `htmlAusText` macht daraus die Absätze des HTML-Teils.
 *
 * DER VERWALTUNGSLINK STATT DER NACKTEN KENNUNG. Vorher stand hier „In der
 * Verwaltung: Organisation <uuid>" — eine Kennung, die man von Hand in ein
 * Suchfeld tippen musste. Jetzt steht die Adresse da, die ein Klick öffnet.
 */
export function notificationRows(
  dto: PublicInquiryDto,
  email: string,
  companyId: string,
  adminUrl: string,
  outcome: InquiryOutcome = dto.inquiryKind === 'demo'
    ? 'credentials_sent'
    : 'confirmation_sent',
): string[] {
  return [
    introductionFor(dto.inquiryKind, outcome),
    '',
    dto.company ? `Organisation: ${dto.company}` : '',
    dto.kind ? `Art: ${dto.kind}` : '',
    dto.size ? `Größe: ${dto.size}` : '',
    dto.name ? `Ansprechperson: ${dto.name}` : '',
    `E-Mail: ${email}`,
    dto.phone ? `Telefon: ${dto.phone}` : '',
    dto.message ? `\nNachricht:\n${dto.message}` : '',
    '',
    'Bearbeiten lässt sich das in der Verwaltung — Status setzen, Angaben ' +
      'ergänzen, Notiz hinterlegen:',
    adminUrl,
  ].filter((row, i, all) => {
    // Leerzeilen bleiben (sie trennen die Absätze), leere Feldzeilen nicht.
    // Zwei Leerzeilen hintereinander wären ein leerer Absatz.
    if (row !== '') return true;
    return i > 0 && all[i - 1] !== '';
  });
}

/**
 * Wortlaut der SYSTEMERZEUGTEN Notiz — eine einzige Zeile, jedes Wort davon
 * vom System.
 *
 * KEIN FREMDTEXT, auch nicht die Adresse. Das ist die Lehre aus [K1]: Diese
 * Notiz ist unveränderlich, und was unveränderlich ist, darf ein Unbeteiligter
 * nicht schreiben können. Alles Übermittelte steht in der Notiz daneben, die
 * sich löschen lässt.
 */
/**
 * Der Nachweis der AGB-Zustimmung für den Audit-Eintrag: Stand und Wortlaut,
 * wie das Formular sie geschickt hat. Leer, wenn nicht zugestimmt wurde –
 * bei einer Demo-Anfrage ist das der Normalfall.
 *
 * Im AUDIT-Eintrag und nicht in der Systemnotiz: Der Wortlaut ist Fremdtext,
 * und die Systemnotiz enthält nach [K1] nur Wörter des Systems.
 */
export function termsEvidence(
  dto: PublicInquiryDto,
): { terms?: { state: string; wording: string } } {
  if (dto.terms !== true || !dto.termsVersion || !dto.termsWording) return {};
  return { terms: { state: dto.termsVersion, wording: dto.termsWording } };
}

export function systemRow(
  kind: InquiryKind,
  tag: string,
  again: boolean,
  termsAgreed = false,
): string {
  const label = kind === 'demo' ? 'Demo-Anfrage' : 'Pilot-Anfrage';
  const row = again
    ? `Erneute ${label} über das Formular, ${dayReadable(tag)}`
    : `${label} über das Formular, ${dayReadable(tag)}`;
  // Nur OB zugestimmt wurde, in Worten des Systems – der Wortlaut steht im
  // Audit-Eintrag (siehe `agbNachweis`).
  return termsAgreed ? `${row} · AGB-Zustimmung erteilt` : row;
}

/**
 * Wortlaut der Notiz mit den ÜBERMITTELTEN ANGABEN.
 *
 * Die erste Zeile stammt vom System und sagt, woher der Rest kommt. Jede
 * weitere besteht aus einem Feldnamen des Systems und einem eingefassten,
 * einzeiligen Fremdwert (siehe `fremdtext.ts`). Ein Wert kann damit keine
 * eigene Zeile beginnen und deshalb auch keine Systemzeile nachbauen.
 *
 * `null`, wenn außer der Adresse nichts übermittelt wurde — dann steht schon
 * alles am Datensatz.
 */
export function submittedDetails(
  dto: PublicInquiryDto,
  email: string,
): string | null {
  const rows = [
    detail('E-Mail', email),
    detail('Ansprechperson', dto.name),
    detail('Organisation', dto.company),
    detail('Telefon', dto.phone),
    detail('Art', dto.kind),
    detail('Größe', dto.size),
    detail('Nachricht', dto.message),
  ].filter((row): row is string => row !== null);
  if (rows.length === 0) return null;
  return [
    'Übermittelte Angaben aus dem Formular (Wortlaut der anfragenden Person):',
    ...rows,
  ].join('\n');
}
