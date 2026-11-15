import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConsentStatus } from '.prisma/control-client';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import { withMinDuration } from '../auth/constant-time-response';
import type { InquirySource } from '../common/inquiry-source';
import { baseUrl } from '../common/base-url';
import { MailService } from '../mail/mail.service';
import type { DbClient } from '../prisma/db-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  newToken,
  normalizeAddress,
  lockKeyForAddress,
} from './address';
import {
  UnsubscribeUnknownError,
  ConfirmationUnknownError,
} from './consent.errors';
import { mayBlockWrite } from './block-rank';

/**
 * GÜLTIGKEIT DES BESTÄTIGUNGSLINKS — 72 Stunden.
 *
 * Danach wird die unbestätigte Zeile GELÖSCHT (`aufraeumen.service.ts`). Das
 * ist die einzige automatische Löschung im ganzen Projekt und die einzige
 * Ausnahme von R4; die Begründung steht dort.
 */
export const CONFIRMATION_VALID_HOURS = 72;

/**
 * ===========================================================================
 * [K2] DAS KONTINGENT JE ADRESSE — und warum das Rate-Limit dafür nicht reicht
 * ===========================================================================
 *
 * Gemessen wurde: zwölf Eintragungen für DIESELBE fremde Adresse, je eigene
 * Quell-IP, zwölfmal `200`, zwölf Bestätigungsmails im Postfach des Opfers.
 * Das globale Rate-Limit zählt gegen den ABSENDER; wer über genügend Adressen
 * verfügt, umgeht es. Gezählt werden muss deshalb zusätzlich gegen das ZIEL.
 *
 * ZWEI GRENZEN, und beide sind nötig:
 *
 * - `MAIL_SPERRFRIST_MINUTEN` — höchstens eine Bestätigungsmail je Stunde.
 *   Sie bricht den Schwall.
 * - `MAX_BESTAETIGUNGSMAILS` — höchstens drei je laufendem Vorgang. Sie
 *   verhindert, dass jemand stündlich nachlegt.
 *
 * WAS DIE GRENZE NICHT TUT: Sie ändert die ANTWORT NICHT. Das Formular
 * antwortet weiterhin in jedem Fall gleich — sonst wäre es genau das
 * Adressverzeichnis, gegen das der Rest dieses Dienstes gebaut ist.
 *
 * UND SIE FASST DIE ZEILE NICHT AN. Wer wegen des Kontingents keine Mail
 * bekommt, behält seinen bereits verschickten Bestätigungslink: Ein neuer
 * Token machte den alten ungültig, und dann könnte die Person, der die Adresse
 * gehört, gar nicht mehr bestätigen — der Angriff hätte sein Ziel erreicht.
 */
export const MAIL_BLOCK_PERIOD_MINUTES = 60;

/**
 * ===========================================================================
 * [W8] MINDESTDAUER DER EINTRAGUNG — gegen den Zeitkanal
 * ===========================================================================
 *
 * Die Antwort war immer dieselbe, die ANTWORTZEIT nicht. Gemessen:
 *
 * ```
 * UNBEKANNT (Mail geht raus)  Median 55,7 ms   min 51,5   max 62,4
 * BEKANNT   (keine Mail)      Median  4,9 ms   min  3,3   max  6,5
 * Überschneidung: keine
 * ```
 *
 * Mit EINER Anfrage liess sich prüfen, ob eine Adresse im Register steht — das
 * Formular war damit genau das Adressverzeichnis, gegen das der ganze Rest
 * dieses Dienstes gebaut ist. Über einen echten Relay mit TLS wird der Abstand
 * grösser, nicht kleiner.
 *
 * BITTER: Das Kontingent aus [K2] hat den schnellen Pfad noch VERBREITERT —
 * es kehrt früh zurück, ohne Token, ohne Mail. Eine Reparatur, die eine
 * andere Lücke aufreisst.
 *
 * DIESELBE LÖSUNG WIE BEI `fordereAnmeldecodeAn` ([K2] der Etappe 1), und aus
 * demselben Grund zwei Teile:
 *
 * 1. Der Mailversand liegt AUSSERHALB des Antwortpfads (`void`). Im
 *    Antwortpfad darf nichts stehen, dessen Dauer von aussen bestimmt wird.
 * 2. Diese Schranke deckelt den Rest. Solange alle Zweige darunter bleiben,
 *    ist die gemessene Zeit für alle dieselbe.
 *
 * 200 ms: deutlich über dem langsamsten gemessenen Zweig (62 ms) und über dem,
 * was ein zweiter Datenbankzugriff kostet, aber niedrig genug, dass ein
 * Formular nicht träge wirkt.
 */
export const SUBSCRIPTION_MIN_DURATION_MS = 200;

/** Höchstzahl Bestätigungsmails je laufendem Bestätigungsvorgang. */
export const MAX_CONFIRMATION_MAILS = 3;

/**
 * Was in `formulartextImWortlaut` steht, wenn ein Sperreintrag ohne
 * vorhergehende Einwilligung entsteht ([W4]).
 */
export const BLOCK_WITHOUT_CONSENT =
  'Kein Einwilligungsnachweis — dieser Eintrag entstand als reine Sperre auf ' +
  'einen Widerspruch, der uns ausserhalb des Abmeldelinks erreicht hat ' +
  '(Art. 21 Abs. 1 DSGVO, § 7 UWG).';

/** Was ein Empfänger im Redaktionsbereich zu sehen bekommt. */
export interface RecipientRow {
  consentId: string;
  email: string;
  companyId: string | null;
  companyName: string | null;
  confirmedAt: string | null;
  /** WO das Formular stand, z. B. „webseite-newsletter". */
  origin: string | null;
}

/** Eine Zeile der Sperrliste. */
export interface BlockRow {
  consentId: string;
  email: string;
  /** Der Zustand, der die Sperre trägt. */
  status: 'unsubscribed' | 'hard_bounced' | 'spam_reported';
  /**
   * Der Anlass im Wortlaut — nur bei einer Sperre VON HAND.
   *
   * Bei einer Abmeldung über den Link steht hier nichts, und das ist richtig:
   * Wer sich selbst abmeldet, nennt keinen Anlass. Einen zu erfinden wäre
   * eine Behauptung über eine fremde Handlung.
   *
   * Auch nach einer Kontaktdatenlöschung ist er leer — er ist ein Freitext
   * über eine Person und geht mit ihren Daten.
   */
  reason: string | null;
  /** Wann die Sperre wirksam wurde. */
  registeredAt: string | null;
}

/** Was eine Sperrmeldung bewirkt hat. */
export interface BlockResult {
  consentId: string;
  /** Gab es zu der Adresse vorher gar keinen Eintrag? */
  created: boolean;
  /** Wie viele schon eingestellte Mails dabei abgebrochen wurden. */
  abortedMails: number;
  /** Der Zustand, der DANACH gilt — nicht zwingend der gemeldete ([K4]). */
  status: ConsentStatus;
  /**
   * Die Meldung war eine Abschwächung und wurde deshalb nicht geschrieben.
   *
   * Der Aufrufer bekommt das zu sehen, damit die Oberfläche nicht „gesperrt
   * als abgemeldet" anzeigt, wo in Wahrheit `spam_gemeldet` stehen bleibt.
   */
  weakenedRefused: boolean;
}

/** Der vollständige Nachweis einer Einwilligung. */
export interface EvidenceRow {
  consentId: string;
  email: string;
  status: ConsentStatus;
  origin: string | null;
  formText: string;
  subscribedAt: string | null;
  ipAtSubscription: string | null;
  confirmedAt: string | null;
  ipAtConfirmation: string | null;
  unsubscribedAt: string | null;
  deactivatedAt: string | null;
  /** DASS es einen Token gibt, nicht welchen. */
  confirmationTokenPresent: boolean;
  unsubscribeTokenPresent: boolean;
}

/**
 * ===========================================================================
 * DAS ADRESSREGISTER — Einwilligungsnachweis UND Sperrliste in einer Tabelle
 * ===========================================================================
 *
 * `Einwilligung` ist beides, und das ist Absicht. Eine Abmeldung LÖSCHT die
 * Zeile nicht, sie setzt sie auf `abgemeldet`. Ohne diesen Rest wäre die
 * Person nach dem nächsten Import wieder im Verteiler — der häufigste Weg, auf
 * dem ein Widerspruch praktisch wirkungslos wird.
 *
 * FÜNF ZUSTÄNDE, und nur einer erlaubt Post:
 *
 *   unbestaetigt   — eingetragen, aber niemand hat bestätigt. BEKOMMT NICHTS.
 *                    Wird nach 72 Stunden gelöscht.
 *   bestaetigt     — der einzige Zustand, in dem eine werbliche Mail hinausgeht.
 *   abgemeldet     — Sperreintrag nach Ein-Klick-Abmeldung.
 *   hart_abgewiesen— Adresse nimmt nichts mehr an (drei erfolglose Versuche).
 *   spam_gemeldet  — Beschwerde. Der einzige Zustand, aus dem es KEINEN Weg
 *                    zurück gibt, auch nicht über eine neue Eintragung.
 *
 * WARUM `hart_abgewiesen` UND `spam_gemeldet` PFLICHT SIND: Weiterversand an
 * tote oder beschwerdeführende Adressen ruiniert die Zustellbarkeit der ganzen
 * Domäne — einschliesslich der Rechnungsmails. Die Sperrliste schützt hier
 * nicht in erster Linie den Empfänger, sondern den Postausgang.
 *
 * WORAUF SICH DER VERSAND NICHT STÜTZT: `Organisation.newsletterEinwilligungStatus`.
 * Dieses Feld ist eine ANZEIGE und von Hand über das Organisations-Formular
 * setzbar. Es wird hier bei jeder Änderung nachgeführt, damit es nicht lügt —
 * aber weder die Empfängerauswahl noch das Tor lesen es je. Wäre es anders,
 * könnte ein Häkchen im CRM eine Einwilligung erfinden, die es nie gab.
 */
@Injectable()
export class ConsentService {
  private readonly logger = new Logger(ConsentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Eintragung über das Anmeldeformular. Erster Schritt des Double-Opt-in.
   *
   * ANTWORTET IMMER GLEICH — der Aufrufer erfährt nicht, ob die Adresse schon
   * eingetragen, bereits bestätigt oder gesperrt ist. Sonst wäre das Formular
   * ein Verzeichnis, mit dem sich jede Adresse auf Zugehörigkeit prüfen liesse.
   *
   * DER NACHWEIS ENTSTEHT HIER, und er ist der eigentliche Wert: Zeitpunkt,
   * IP, Formulartext IM WORTLAUT, später Bestätigungszeitpunkt und Token.
   * Ohne ihn ist das Häkchen wertlos — im Streitfall zählt nicht, dass jemand
   * zugestimmt hat, sondern dass sich zeigen lässt, WOZU.
   */
  async subscribe(
    input: {
      email: string;
      formText: string;
      origin?: string;
      companyId?: string;
      /** Honeypot aus dem Formular. Ausgefüllt = Bot. */
      website?: string;
    },
    source: InquirySource,
  ): Promise<void> {
    // [W8]: JEDER Zweig braucht dieselbe Zeit — auch der Honeypot-Zweig und
    // der, den das Kontingent früh abbricht.
    await withMinDuration(SUBSCRIPTION_MIN_DURATION_MS, () =>
      this.subscribeInternal(input, source),
    );
  }

  /** Der eigentliche Ablauf. Siehe `anmelden` für die Zeitschranke. */
  private async subscribeInternal(
    input: {
      email: string;
      formText: string;
      origin?: string;
      companyId?: string;
      website?: string;
    },
    source: InquirySource,
  ): Promise<void> {
    if (input.website !== undefined && input.website.trim() !== '') {
      // Nach aussen dieselbe Antwort, aber nichts angelegt und nichts
      // verschickt — dasselbe Vorgehen wie beim Anfrageformular. Der Nachweis
      // bleibt, damit sich Wellen erkennen lassen.
      this.logger.warn('Newsletter-Eintragung mit ausgefülltem Honeypot verworfen.');
      await this.audit.log({
        userId: null,
        actor: 'form',
        action: AUDIT_ACTION.consentSubscriptionRefused,
        objectType: 'Consent',
        objectId: null,
        afterValue: { reason: 'honeypot' },
        ...source,
      });
      return;
    }

    const email = normalizeAddress(input.email);

    const result = await this.prisma.$transaction(async (tx) => {
      // BERATUNGSSPERRE AUF DER ADRESSE, nicht auf der Zeile: Beim ersten
      // Eintragen gibt es noch keine Zeile, die sich sperren liesse. Zwei
      // gleichzeitige Formularabsendungen sähen sonst beide „kennen wir
      // nicht", liefen beide in ein `create`, und die zweite scheiterte am
      // eindeutigen Index — die Absenderin bekäme einen Serverfehler.
      // `$executeRaw` und nicht `$queryRaw`: die Sperrfunktion liefert `void`.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKeyForAddress(email)})`;
      const present = await tx.consent.findUnique({
        where: { email },
        select: {
          id: true,
          status: true,
          companyId: true,
          confirmationMailAt: true,
          confirmationMailCount: true,
        },
      });

      // Eine Spam-Meldung ist endgültig. Wer sich beschwert hat, wird nicht
      // dadurch wieder anschreibbar, dass jemand seine Adresse erneut in ein
      // Formular tippt.
      if (present?.status === 'spam_reported') {
        await this.audit.log(
          {
            userId: null,
            actor: 'form',
            action: AUDIT_ACTION.consentSubscriptionRefused,
            objectType: 'Consent',
            objectId: present.id,
            afterValue: { reason: 'spam_reported' },
            ...source,
          },
          tx,
        );
        return null;
      }

      // Bereits bestätigt: nichts ändern, nichts verschicken. Eine zweite
      // Bestätigungsmail brächte nichts und liesse sich über das Formular
      // beliebig oft an eine fremde Adresse auslösen.
      if (present?.status === 'confirmed') {
        await this.audit.log(
          {
            userId: null,
            actor: 'form',
            action: AUDIT_ACTION.consentSubscriptionRefused,
            objectType: 'Consent',
            objectId: present.id,
            afterValue: { reason: 'bereits_bestaetigt' },
            ...source,
          },
          tx,
        );
        return null;
      }

      // [K2] KONTINGENT JE ADRESSE. Steht VOR dem Erzeugen des neuen Tokens:
      // Wer wegen der Sperre keine Mail bekommt, behält den alten Link.
      //
      // ES GILT NUR FÜR EINEN NOCH UNBESTÄTIGTEN VORGANG. Eine Zeile auf
      // `abgemeldet` oder `hart_abgewiesen` hat den Bestätigungsweg bereits
      // einmal vollständig durchlaufen — und die Abmeldung setzt den
      // Abmeldetoken voraus, den nur bekommt, wer Zugriff auf das Postfach
      // hat. Der Zustand ist damit ein Beleg dafür, dass die Adresse dem
      // gehört, der sie benutzt; ihn mit einer Sperrfrist zu belegen hiesse,
      // die eigene Rückkehr zu bestrafen. Für einen Angreifer ist dieser Weg
      // nicht erreichbar: Er hat den Abmeldetoken nicht.
      if (present && present.status === 'unconfirmed') {
        const state = await tx.consent.findUniqueOrThrow({
          where: { id: present.id },
          select: { confirmationMailAt: true, confirmationMailCount: true },
        });
        const reason = this.quotaReason(state);
        if (reason) {
          await this.audit.log(
            {
              userId: null,
              actor: 'form',
              action: AUDIT_ACTION.consentSubscriptionRefused,
              objectType: 'Consent',
              objectId: present.id,
              afterValue: { reason },
              ...source,
            },
            tx,
          );
          this.logger.warn(
            `Kontingent für Bestätigungsmails ausgeschöpft (${reason}); es geht ` +
              'nichts hinaus. Die Antwort bleibt unverändert.',
          );
          return null;
        }
      }

      const token = newToken();
      const data = {
        email,
        companyId: input.companyId ?? null,
        status: 'unconfirmed' as const,
        subscribedAt: new Date(),
        ipAtSubscription: source.ip,
        formText: input.formText,
        origin: input.origin ?? null,
        confirmationToken: token,
        // Ab jetzt zählt der Vorgang. Der Zähler wird beim Weiterzählen unten
        // gesetzt; hier steht der Anfangswert für eine neue Zeile.
        confirmationMailAt: new Date(),
        // Eine erneute Eintragung setzt den alten Vorgang vollständig zurück.
        // Sonst stünde neben dem neuen Nachweis noch der Bestätigungs- oder
        // Abmeldezeitpunkt eines früheren, und der Nachweis wäre
        // widersprüchlich.
        confirmedAt: null,
        ipAtConfirmation: null,
        unsubscribedAt: null,
        unsubscribeToken: null,
        deactivatedAt: null,
      };

      const row = present
        ? await tx.consent.update({
            where: { id: present.id },
            data: {
              ...data,
              // WEITERZÄHLEN, nicht zurücksetzen: `kontingentGrund` hat oben
              // bereits entschieden, ob der Vorgang noch läuft. Läuft er,
              // erhöht sich der Zähler; ist er erloschen, beginnt er bei eins.
              confirmationMailCount:
                present.status === 'unconfirmed'
                  ? this.nextCount(present)
                  : 1,
            },
            select: { id: true, companyId: true },
          })
        : await tx.consent.create({
            data: { ...data, confirmationMailCount: 1 },
            select: { id: true, companyId: true },
          });

      await this.mirrorToCompany(tx, row.companyId, 'unconfirmed');
      if (present?.companyId && present.companyId !== row.companyId) {
        await this.mirrorToCompany(tx, present.companyId, null);
      }

      await this.audit.log(
        {
          userId: null,
          actor: 'form',
          action: AUDIT_ACTION.consentSubscribed,
          objectType: 'Consent',
          objectId: row.id,
          afterValue: {
            origin: input.origin ?? null,
            again: present !== null,
            formTextLength: input.formText.length,
          },
          ...source,
        },
        tx,
      );

      return { id: row.id, token };
    });

    if (!result) return;

    // ===================================================================
    // [W8] DER VERSAND HÄNGT NICHT IM ANTWORTPFAD
    // ===================================================================
    //
    // Vorher stand hier ein `await` mit einem `catch` daneben. Das `catch`
    // deckte den FEHLSCHLAG ab — aber nicht den Unterschied „Mail gegangen"
    // gegen „keine Mail gegangen". Genau der war messbar: 55,7 ms gegen
    // 4,9 ms, ohne jede Überschneidung. Eine einzige Anfrage genügte, um zu
    // erfahren, ob eine Adresse im Register steht.
    //
    // Ausserhalb der Transaktion war es schon vorher, und das bleibt so: Ein
    // SMTP-Roundtrip in einer offenen Datenbanktransaktion hielte Sperren
    // über Sekunden, und ein Verbindungsfehler machte den bereits erfassten
    // Nachweis rückgängig.
    void this.sendConfirmationConcurrent(email, result.id, result.token);
  }

  /**
   * Verschickt die Bestätigungsmail, ohne dass der Aufrufer darauf wartet.
   *
   * WIRFT NIE — eine unbehandelte Ablehnung würde den Prozess in Node mit
   * `--unhandled-rejections=throw` beenden. Sichtbar bleibt ein kaputter
   * Postausgang im Anwendungslog und unter `GET /api/zugang/postausgang`;
   * beide sind nicht anonym erreichbar.
   */
  private async sendConfirmationConcurrent(
    email: string,
    consentId: string,
    token: string,
  ): Promise<void> {
    try {
      await this.mail.sendConsentConfirmation(
        email,
        this.confirmationLink(token),
        CONFIRMATION_VALID_HOURS,
      );
    } catch (exception) {
      this.logger.error(
        `Bestätigungsmail zu Einwilligung ${consentId} ging nicht ` +
          `hinaus: ${exception instanceof Error ? exception.message : String(exception)}`,
      );
    }
  }

  /**
   * Zweiter Schritt: der Klick im Postfach. Erst er macht die Einwilligung zu
   * einer.
   *
   * IDEMPOTENT. Ein zweiter Klick auf denselben Link — der Vorschaudienst
   * eines Mailclients ruft ihn gern von selbst auf — meldet denselben Erfolg
   * und ändert nichts.
   */
  async confirm(
    token: string,
    source: InquirySource,
  ): Promise<{ consentId: string }> {
    const row = await this.prisma.consent.findUnique({
      where: { confirmationToken: token },
      select: { id: true, status: true, subscribedAt: true, companyId: true },
    });

    if (!row || row.status === 'spam_reported') {
      await this.audit.log({
        userId: null,
        actor: 'confirmationLink',
        action: AUDIT_ACTION.consentConfirmationInvalid,
        objectType: 'Consent',
        objectId: row?.id ?? null,
        afterValue: { reason: row ? 'blocked' : 'unknown' },
        ...source,
      });
      throw new ConfirmationUnknownError();
    }

    if (row.status === 'confirmed') return { consentId: row.id };

    // Der Aufräumlauf läuft stündlich; zwischen Ablauf und Löschung können
    // Minuten liegen. Die Frist wird deshalb HIER noch einmal gerechnet und
    // nicht dem Aufräumlauf überlassen.
    if (!row.subscribedAt || this.expired(row.subscribedAt)) {
      await this.audit.log({
        userId: null,
        actor: 'confirmationLink',
        action: AUDIT_ACTION.consentConfirmationInvalid,
        objectType: 'Consent',
        objectId: row.id,
        afterValue: { reason: 'expired' },
        ...source,
      });
      throw new ConfirmationUnknownError();
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Consent" WHERE "id" = ${row.id} FOR UPDATE`;
      // BEDINGT SCHREIBEN, nicht blind. Zwischen dem Lesen oben und dieser
      // Zeile kann der Aufräumlauf die abgelaufene Eintragung gelöscht oder
      // ein zweiter Klick sie bereits bestätigt haben. `updateMany` trifft
      // dann nichts und meldet `count: 0` — ein `update` würde stattdessen
      // mit einem Prisma-Fehler abbrechen und als „interner Fehler" im
      // Browser der Empfängerin landen.
      const { count } = await tx.consent.updateMany({
        where: { id: row.id, status: 'unconfirmed' },
        data: {
          status: 'confirmed',
          confirmedAt: new Date(),
          ipAtConfirmation: source.ip,
          // Der Abmeldetoken entsteht ERST JETZT und lebt so lange wie der
          // Eintrag. Er steht in jeder werblichen Mail; ohne ihn erteilt das
          // Tor keine Freigabe.
          unsubscribeToken: newToken(),
        },
      });
      if (count === 0) throw new ConfirmationUnknownError();
      await this.mirrorToCompany(tx, row.companyId, 'confirmed');
      await this.audit.log(
        {
          userId: null,
          actor: 'confirmationLink',
          action: AUDIT_ACTION.consentConfirmed,
          objectType: 'Consent',
          objectId: row.id,
          beforeValue: { status: 'unconfirmed' },
          afterValue: { status: 'confirmed' },
          ...source,
        },
        tx,
      );
    });

    return { consentId: row.id };
  }

  /**
   * EIN-KLICK-ABMELDUNG. Kein Login, keine Rückfrage, sofort wirksam.
   *
   * Zwei Dinge in EINER Transaktion, und die Reihenfolge der Sperren ist
   * Absicht:
   *
   * 1. Die Einwilligungszeile wird gesperrt (`FOR UPDATE`) und auf
   *    `abgemeldet` gesetzt.
   * 2. Alle noch NICHT übernommenen Warteschlangenzeilen dieser Einwilligung
   *    werden abgewiesen.
   *
   * Der Versandlauf sperrt dieselbe Zeile in derselben Reihenfolge (erst
   * Einwilligung, dann Warteschlangenzeile). Dadurch gibt es genau zwei
   * mögliche Ausgänge und keinen dritten: Entweder die Abmeldung war zuerst
   * fertig — dann findet der Versand `abgemeldet` und schickt nichts —, oder
   * der Versand hatte die Zeile schon übernommen und SMTP läuft bereits; dann
   * geht genau diese eine Mail noch hinaus und keine weitere. Ein Fenster, in
   * dem beide gleichzeitig entscheiden, existiert nicht.
   *
   * Die gleiche Sperrreihenfolge auf beiden Seiten ist auch der Grund, warum
   * hier kein Deadlock entstehen kann.
   */
  async unsubscribe(
    token: string,
    source: InquirySource,
  ): Promise<{ consentId: string; abortedMails: number }> {
    const row = await this.prisma.consent.findUnique({
      where: { unsubscribeToken: token },
      select: { id: true, status: true, companyId: true },
    });
    if (!row) {
      await this.audit.log({
        userId: null,
        actor: 'unsubscribeLink',
        action: AUDIT_ACTION.consentUnsubscribeInvalid,
        objectType: 'Consent',
        objectId: null,
        afterValue: { reason: 'unknown' },
        ...source,
      });
      throw new UnsubscribeUnknownError();
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Consent" WHERE "id" = ${row.id} FOR UPDATE`;
      const now = await tx.consent.findUniqueOrThrow({
        where: { id: row.id },
        select: { status: true },
      });

      // Idempotent: Ein zweiter Klick meldet denselben Erfolg. Ein bereits
      // stillgelegter Eintrag bleibt stillgelegt — er ist bereits gesperrt,
      // und die Stilllegung trägt mehr Information als die Abmeldung.
      if (now.status === 'confirmed' || now.status === 'unconfirmed') {
        await tx.consent.update({
          where: { id: row.id },
          data: { status: 'unsubscribed', unsubscribedAt: new Date() },
        });
        await this.mirrorToCompany(tx, row.companyId, 'unsubscribed');
      }

      const { count } = await tx.mailDelivery.updateMany({
        where: {
          consentId: row.id,
          deliveryStatus: 'queued',
        },
        data: {
          deliveryStatus: 'rejected',
          lastErrorClass: 'unsubscribed',
          lastAttemptAt: new Date(),
          nextAttemptFrom: null,
        },
      });

      await this.audit.log(
        {
          userId: null,
          actor: 'unsubscribeLink',
          action: AUDIT_ACTION.consentUnsubscribed,
          objectType: 'Consent',
          objectId: row.id,
          beforeValue: { status: now.status },
          afterValue: { status: 'unsubscribed', abortedMails: count },
          ...source,
        },
        tx,
      );

      return { consentId: row.id, abortedMails: count };
    });
  }

  /**
   * Legt eine Adresse still — nach drei erfolglosen Zustellversuchen oder auf
   * eine Beschwerde hin.
   *
   * KEIN LÖSCHEN, sondern ein Sperreintrag: Der Zweck ist gerade, dass die
   * Adresse bekannt bleibt und nicht wieder angeschrieben wird.
   */
  async deactivate(
    db: DbClient,
    consentId: string,
    status: 'hard_bounced' | 'spam_reported',
    reason: string,
    actor = 'versandlauf',
  ): Promise<void> {
    const row = await db.consent.update({
      where: { id: consentId },
      data: { status, deactivatedAt: new Date() },
      select: { id: true, companyId: true },
    });
    await db.mailDelivery.updateMany({
      where: { consentId, deliveryStatus: 'queued' },
      data: {
        deliveryStatus: 'rejected',
        lastErrorClass: status,
        lastAttemptAt: new Date(),
        nextAttemptFrom: null,
      },
    });
    await this.mirrorToCompany(db, row.companyId, status);
    await this.audit.log(
      {
        userId: null,
        actor,
        action: AUDIT_ACTION.consentDeactivated,
        objectType: 'Consent',
        objectId: consentId,
        afterValue: { status, reason },
        ip: null,
        userAgent: null,
      },
      db,
    );
    this.logger.warn(
      `Adresse stillgelegt (Einwilligung ${consentId}): ${reason}.`,
    );
  }

  /**
   * ===========================================================================
   * [W4] WIDERSPRUCH AUSSERHALB DES ABMELDELINKS — von Hand eingetragen
   * ===========================================================================
   *
   * Bis hierher gab es genau EINEN Weg, eine Adresse zu sperren: den Token aus
   * einer unserer Mails. Das reicht nicht:
   *
   * - Art. 21 Abs. 1 DSGVO und § 7 UWG binden die Wirksamkeit eines
   *   Widerspruchs an KEINEN Kanal. Wer anruft, zurückschreibt oder einen
   *   Brief schickt, hat wirksam widersprochen — und wir müssen es umsetzen
   *   können.
   * - `spam_gemeldet` wurde nirgends geschrieben, obwohl der Zustand als
   *   Pflicht beschrieben ist. Eine Beschwerde erreicht uns über den
   *   Postfachanbieter, nie über unseren eigenen Link.
   * - Und die Abmeldeseite versprach „Antworte auf eine unserer Mails, wir
   *   tragen dich von Hand aus" — ein Versprechen ohne Weg dahinter.
   *
   * ZWEI EIGENSCHAFTEN, DIE ZUSAMMENGEHÖREN:
   *
   * 1. SIE SPERRT NUR. Es gibt keinen Gegenweg, kein `entsperre`, keinen
   *    Statuswechsel zurück auf `bestaetigt`. Eine Route, die entsperren
   *    könnte, wäre der bequemste Weg, R3 zu umgehen — und sie wäre von einer
   *    Sperrroute nicht zu unterscheiden, wenn beide dieselbe Methode
   *    benutzten. Der einzige Weg zurück bleibt eine neue Eintragung durch die
   *    Person selbst, und aus `spam_gemeldet` gibt es auch den nicht.
   * 2. SIE LEGT AN, WENN NICHTS DA IST. Ein Widerspruch von jemandem, der bei
   *    uns gar nicht eingetragen ist, muss trotzdem wirken — sonst schriebe
   *    ihn der nächste Import wieder an. Der Eintrag ist dann von Anfang an
   *    kein Einwilligungsnachweis, sondern nur eine Sperre; der Vermerk sagt
   *    das auch.
   */
  async blockAddress(
    email: string,
    status: 'unsubscribed' | 'hard_bounced' | 'spam_reported',
    note: string,
    actor: { userId: string | null; name: string },
    source: InquirySource,
  ): Promise<BlockResult> {
    const address = normalizeAddress(email);
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKeyForAddress(address)})`;
      const present = await tx.consent.findUnique({
        where: { email: address },
        select: { id: true, status: true, companyId: true },
      });

      // ===================================================================
      // [K4] EINE SPERRE WIRD NUR STÄRKER, NIE SCHWÄCHER
      // ===================================================================
      //
      // DIE ZEILE, DIE GEFEHLT HAT. Vorher wurde der mitgegebene Zustand
      // bedingungslos geschrieben — damit liess sich `spam_gemeldet` auf
      // `abgemeldet` herunterstufen, und die nächste Formulareintragung machte
      // die Adresse wieder anschreibbar. Eine Double-Opt-in-Mail an eine
      // Adresse, die uns gerade als Spam gemeldet hat, ist der Vorgang, der
      // die Blocklistung der Domäne auslöst — und die trägt auch die
      // Rechnungsmails.
      //
      // Gelesen wird NACH dem `pg_advisory_xact_lock`: Sonst wäre die Prüfung
      // ein check-then-act, und zwei gleichzeitige Meldungen könnten sich
      // gegenseitig überschreiben.
      const weakened =
        present !== null && !mayBlockWrite(present.status, status);

      const shared = {
        status,
        // `abgemeldetAm` bei einem Widerspruch, `stillgelegtAm` bei einer
        // Systementscheidung — beides zu setzen verwischte, WER gehandelt hat.
        ...(status === 'unsubscribed'
          ? { unsubscribedAt: now }
          : { deactivatedAt: now }),
        // DER ANLASS IM WORTLAUT — die Angabe, die hier bis zum Redesign
        // verloren ging. Sie wurde als Pflichtfeld erhoben, auf zehn Zeichen
        // Mindestlänge geprüft und dann ausschliesslich als LÄNGE ins
        // Audit-Log geschrieben. Wer später fragte, warum er keine Post mehr
        // bekommt, hätte „es wurden 21 Zeichen erfasst" zur Antwort bekommen.
        //
        // Er wandert MIT DEM ZUSTAND: Wird eine schwächere Sperre durch eine
        // stärkere ersetzt, gehört der neue Anlass zum neuen Zustand. Bleibt
        // der alte Zustand stehen ([K4]), bleibt auch sein Anlass stehen —
        // sonst stünde neben „spam_gemeldet" die Begründung einer Abmeldung.
        blockReason: note.trim(),
      };

      const row = present
        ? await tx.consent.update({
            where: { id: present.id },
            // BEI GLEICHEM ODER HÖHEREM RANG BLEIBT DER ZUSTAND STEHEN. Die
            // Meldung wird trotzdem angenommen und protokolliert — sie ist ja
            // nicht falsch, sie fügt nur nichts hinzu.
            data: weakened ? {} : shared,
            select: { id: true, companyId: true },
          })
        : await tx.consent.create({
            data: {
              email: address,
              ...shared,
              // KEIN NACHWEIS, sondern eine Sperre. Der Text sagt das, damit
              // niemand ihn später für eine Einwilligung hält.
              formText: BLOCK_WITHOUT_CONSENT,
              origin: 'sperre-von-hand',
            },
            select: { id: true, companyId: true },
          });

      // Was schon in der Warteschlange steht, geht nicht mehr hinaus. Ohne
      // diesen Schritt wirkte der Widerspruch erst ab der nächsten Rundmail.
      //
      // DAS PASSIERT AUCH BEI EINER ABGESCHWÄCHTEN MELDUNG: Zeilen abzubrechen
      // schwächt nichts ab, und wer widerspricht, soll nicht deshalb noch Post
      // bekommen, weil er den falschen Grund genannt hat.
      const { count } = await tx.mailDelivery.updateMany({
        where: { consentId: row.id, deliveryStatus: 'queued' },
        data: {
          deliveryStatus: 'rejected',
          lastErrorClass: status,
          lastAttemptAt: now,
          nextAttemptFrom: null,
        },
      });

      const applicableStatus = weakened ? present!.status : status;
      await this.mirrorToCompany(tx, row.companyId, applicableStatus);
      await this.audit.log(
        {
          userId: actor.userId,
          actor: actor.name,
          action: AUDIT_ACTION.consentBlockedManually,
          objectType: 'Consent',
          objectId: row.id,
          beforeValue: { status: present?.status ?? null },
          // KEINE ADRESSE UND KEIN FREITEXT im Nachweis: Das Audit-Log hat
          // keinen Löschweg. Die Länge belegt, dass eine Begründung erfasst
          // wurde; ihr Wortlaut steht seit dem Redesign tatsächlich am
          // Eintrag (`Einwilligung.sperrAnlass`) — vorher behauptete dieser
          // Kommentar das nur, und die Spalte gab es nicht.
          afterValue: {
            status: applicableStatus,
            reported: status,
            // [K4]: Eine abgewiesene Abschwächung MUSS im Nachweis stehen.
            // Sonst sähe der Eintrag aus wie eine erfolgreiche Herabstufung,
            // und niemand könnte später sagen, warum der Zustand ein anderer
            // ist als der gemeldete.
            weakenedRefused: weakened,
            created: present === null,
            abortedMails: count,
            justificationLength: note.length,
          },
          ...source,
        },
        tx,
      );

      this.logger.warn(
        weakened
          ? `Sperrmeldung „${status}" für Einwilligung ${row.id} angenommen, ` +
              `aber NICHT geschrieben: der bestehende Zustand ` +
              `„${present!.status}" ist stärker oder gleich stark ([K4]).`
          : `Adresse von Hand gesperrt (Einwilligung ${row.id}, Status ${status}).`,
      );
      return {
        consentId: row.id,
        created: present === null,
        abortedMails: count,
        status: applicableStatus,
        weakenedRefused: weakened,
      };
    });
  }

  /**
   * WER GENAU DIE MAIL BEKOMMT — die Vorschau der Empfängerauswahl.
   *
   * Ausschliesslich `bestaetigt`. Die Liste ist eine VORHERSAGE, keine
   * Zusage: Massgeblich bleibt die Prüfung beim Versand (R3). Zwischen dieser
   * Abfrage und dem Versand kann jeder Eintrag widerrufen werden.
   */
  async recipient(): Promise<RecipientRow[]> {
    const rows = await this.prisma.consent.findMany({
      where: { status: 'confirmed' },
      select: {
        id: true,
        email: true,
        confirmedAt: true,
        origin: true,
        companyId: true,
        company: { select: { name: true } },
      },
      orderBy: { email: 'asc' },
    });
    return rows.map((row) => ({
      consentId: row.id,
      email: row.email,
      companyId: row.companyId,
      companyName: row.company?.name ?? null,
      confirmedAt: row.confirmedAt?.toISOString() ?? null,
      origin: row.origin,
    }));
  }

  /**
   * Zwei Zahlen für die Reiterleiste: bestätigte Adressen und Sperren.
   *
   * BEIDES IST EINE MOMENTAUFNAHME. Massgeblich für den Versand bleibt die
   * Prüfung unmittelbar vor jeder einzelnen Mail (R3) — diese Zahl ist eine
   * Auskunft, keine Zusage.
   */
  async count(): Promise<{ confirmed: number; blocked: number }> {
    const [confirmed, blocked] = await Promise.all([
      this.prisma.consent.count({ where: { status: 'confirmed' } }),
      this.prisma.consent.count({
        where: {
          status: { in: ['unsubscribed', 'hard_bounced', 'spam_reported'] },
        },
      }),
    ]);
    return { confirmed, blocked };
  }

  /**
   * DIE SPERRLISTE — jede Adresse, die nichts Werbliches mehr bekommt.
   *
   * Sie ist rein lesend, und es gibt bewusst kein Gegenstück: Der Dienst
   * kennt keinen Weg, eine Sperre aufzuheben. Wer die Liste sieht, sieht
   * einen Endzustand.
   *
   * ALLE DREI SPERRENDEN ZUSTÄNDE stehen darin, nicht nur die von Hand
   * gesetzten. Eine Liste, die nur die eigenen Einträge zeigte, beantwortete
   * die Frage „wer bekommt nichts mehr" falsch — und genau das ist die Frage,
   * für die es sie gibt.
   *
   * SORTIERT NACH EINTRAGUNG, neueste zuerst. Zwei Spalten kommen dafür in
   * Frage (`abgemeldetAm` bei einem Widerspruch, `stillgelegtAm` bei einer
   * Systementscheidung); genau eine ist je Zeile gesetzt. In SQL zu sortieren
   * hiesse, sie über `COALESCE` zu verschmelzen — hier wird nach dem Lesen
   * sortiert, weil die Liste klein ist und bleibt.
   */
  async blocklist(): Promise<BlockRow[]> {
    const rows = await this.prisma.consent.findMany({
      where: { status: { in: ['unsubscribed', 'hard_bounced', 'spam_reported'] } },
      select: {
        id: true,
        email: true,
        status: true,
        blockReason: true,
        unsubscribedAt: true,
        deactivatedAt: true,
      },
    });
    return rows
      .map((row) => ({
        consentId: row.id,
        email: row.email,
        status: row.status as BlockRow['status'],
        reason: row.blockReason,
        registeredAt: (row.unsubscribedAt ?? row.deactivatedAt) ?? null,
      }))
      .sort(
        (a, b) =>
          (b.registeredAt?.getTime() ?? 0) - (a.registeredAt?.getTime() ?? 0),
      )
      .map((row) => ({
        ...row,
        registeredAt: row.registeredAt?.toISOString() ?? null,
      }));
  }

  /** Der vollständige Nachweis zu einer Adresse — ohne die Token selbst. */
  async evidence(email: string): Promise<EvidenceRow | null> {
    const row = await this.prisma.consent.findUnique({
      where: { email: normalizeAddress(email) },
    });
    if (!row) return null;
    return {
      consentId: row.id,
      email: row.email,
      status: row.status,
      origin: row.origin,
      formText: row.formText,
      subscribedAt: row.subscribedAt?.toISOString() ?? null,
      ipAtSubscription: row.ipAtSubscription,
      confirmedAt: row.confirmedAt?.toISOString() ?? null,
      ipAtConfirmation: row.ipAtConfirmation,
      unsubscribedAt: row.unsubscribedAt?.toISOString() ?? null,
      deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
      // NUR DIE TATSACHE. Wer den Abmeldetoken einer fremden Adresse liest,
      // kann sie abmelden — er gehört in keine Antwort, auch nicht in eine
      // angemeldete.
      confirmationTokenPresent: row.confirmationToken !== null,
      unsubscribeTokenPresent: row.unsubscribeToken !== null,
    };
  }

  /** Die Einwilligung zu einer Adresse, falls es eine gibt. */
  async findByAddress(
    email: string,
  ): Promise<{ id: string; status: ConsentStatus } | null> {
    return this.prisma.consent.findUnique({
      where: { email: normalizeAddress(email) },
      select: { id: true, status: true },
    });
  }

  /**
   * Basisadresse der Links in den Mails, ohne Schrägstrich am Ende.
   *
   * Die Rechnung steht seit [A.34] in `common/basis-url.ts` — sie stand
   * vorher zweimal im Quelltext. Diese Methode bleibt, weil
   * `bestaetigungslink` und `abmeldelink` sie benutzen und weil Tests sie
   * aufrufen; sie entscheidet nur nichts mehr selbst.
   */
  baseUrl(): string {
    return baseUrl(this.config);
  }

  confirmationLink(token: string): string {
    return `${this.baseUrl()}/api/consent/confirmation/${token}`;
  }

  unsubscribeLink(token: string): string {
    return `${this.baseUrl()}/api/consent/unsubscribe/${token}`;
  }

  /**
   * Warum gerade KEINE Bestätigungsmail hinausgeht — oder `null`, wenn eine
   * hinausgehen darf ([K2]).
   *
   * Der Rückgabewert landet ausschliesslich im Audit-Log und im Anwendungslog,
   * niemals in der Antwort.
   */
  private quotaReason(state: {
    confirmationMailAt: Date | null;
    confirmationMailCount: number;
  }): 'sperrfrist' | 'quota' | null {
    if (!state.confirmationMailAt) return null;
    const ageMs = Date.now() - state.confirmationMailAt.getTime();
    if (ageMs < MAIL_BLOCK_PERIOD_MINUTES * 60 * 1000) return 'sperrfrist';
    // Ist die letzte Mail älter als die Gültigkeit des Links, ist der Vorgang
    // erloschen — dann beginnt das Kontingent von vorn. Sonst könnte sich
    // niemand ein Jahr später noch einmal eintragen.
    if (ageMs >= CONFIRMATION_VALID_HOURS * 60 * 60 * 1000) return null;
    return state.confirmationMailCount >= MAX_CONFIRMATION_MAILS
      ? 'quota'
      : null;
  }

  /** Der neue Zählerstand: weiterzählen im laufenden Vorgang, sonst eins. */
  private nextCount(state: {
    confirmationMailAt: Date | null;
    confirmationMailCount: number;
  }): number {
    if (!state.confirmationMailAt) return 1;
    const ageMs = Date.now() - state.confirmationMailAt.getTime();
    if (ageMs >= CONFIRMATION_VALID_HOURS * 60 * 60 * 1000) return 1;
    return state.confirmationMailCount + 1;
  }

  /** Ist die Bestätigungsfrist abgelaufen? */
  private expired(subscribedAt: Date, now = new Date()): boolean {
    const deadline =
      subscribedAt.getTime() + CONFIRMATION_VALID_HOURS * 60 * 60 * 1000;
    return now.getTime() > deadline;
  }

  /**
   * Führt die ANZEIGE an der Organisation nach.
   *
   * Reine Bequemlichkeit für die Oberfläche. Keine Entscheidung hängt daran —
   * siehe Klassenkommentar.
   */
  private async mirrorToCompany(
    db: DbClient,
    companyId: string | null,
    status: ConsentStatus | null,
  ): Promise<void> {
    if (!companyId) return;
    await db.company.update({
      where: { id: companyId },
      data: { newsletterConsentStatus: status },
    });
  }
}
