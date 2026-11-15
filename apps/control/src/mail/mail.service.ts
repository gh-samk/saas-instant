import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { CODE_MAX_FAILED_ATTEMPTS } from '../auth/email-login-code.service';
import { BusinessError } from '../common/errors/business-error';
import { mailBrand } from '@saas-instant/shared';
import { senderAddresses } from './sender';
import { htmlFromText, transactionalLayout } from './layout';
import { buildTransport, transportEnvironment } from './transport';

/**
 * Einordnung eines Versandfehlers — das Einzige, was den Server nach aussen
 * verlässt.
 *
 * Bewusst eine kleine, feste Menge ohne Freitext: sie sagt dem Betrieb, wo er
 * suchen muss, und kann keine Empfängeradresse und keinen Relay-Wortlaut
 * durchsickern lassen.
 *
 * ===========================================================================
 * DIE EINTEILUNG HAT EINE FOLGE, DIE ÜBER „WO SUCHEN" HINAUSGEHT [K1]
 * ===========================================================================
 *
 * Die Warteschlange legt eine Adresse nach drei erfolglosen Zustellungen in
 * Folge STILL, und aus `hart_abgewiesen` gibt es keinen Weg zurück ausser über
 * eine neue Eintragung durch die Person selbst. Welche Klasse dabei mitzählt,
 * entscheidet also über einen unumkehrbaren Vorgang.
 *
 * WAS SCHIEFGING: `unbekannt` war zugleich Auffangwert UND galt als
 * empfängerbezogen. Damit fiel jeder nicht erkannte Fehler des EIGENEN
 * Postausgangs auf die Seite des Empfängers. Gemessen mit einem Postausgang,
 * dessen Name nicht auflöst: nodemailer meldet `EDNS` mit
 * `getaddrinfo ENOTFOUND` — kein damals geprüfter Code passte, also
 * `unbekannt`, also drei Fehlversuche, also Adresse dauerhaft stillgelegt.
 * Ein DNS-Ausfall von zehn Minuten hätte den Verteiler gelöscht.
 *
 * DIE LEHRE, UND SIE GILT ALLGEMEIN: Wenn ein unbekannter Fall Folgen hat,
 * darf die Liste nicht die Ausnahmen aufzählen, sondern muss die erlaubten
 * Fälle aufzählen. Deshalb ist `EMPFAENGERBEZOGENE_KLASSEN` eine WHITELIST mit
 * genau einem Eintrag, und `unbekannt` liegt ausdrücklich auf UNSERER Seite.
 */
export type ErrorClass =
  | 'verbindung'
  | 'tls'
  | 'login'
  /**
   * Der Gegenüber hat UNSERE ABSENDERADRESSE abgelehnt (`MAIL FROM`).
   *
   * Eigene Klasse, weil nodemailer für Absender- und Empfängerabsage denselben
   * Code `EENVELOPE` benutzt. Vorher wurde beides als Empfängerabsage gewertet
   * — ein falsch gesetzter Envelope-From hätte nach drei Rundmails den
   * gesamten Verteiler stillgelegt, obwohl die Empfänger nichts damit zu tun
   * hatten.
   */
  | 'absender_abgewiesen'
  /** Der Gegenüber hat DIESE EMPFÄNGERADRESSE abgelehnt (`RCPT TO`). */
  | 'empfaenger_abgewiesen'
  /** Nicht einzuordnen. Gilt als Fehler auf UNSERER Seite. */
  | 'unknown';

/**
 * DIE WHITELIST: Klassen, die etwas über den EMPFÄNGER aussagen und deshalb
 * gegen seine Adresse zählen dürfen.
 *
 * Genau ein Eintrag, und das ist Absicht. Alles andere — auch und gerade
 * `unbekannt` — ist ein Fehler unseres Postausgangs, bis das Gegenteil
 * bewiesen ist. Die Beweislast liegt auf der Seite, die eine Adresse
 * unumkehrbar sperrt.
 *
 * Steht hier und nicht in der Warteschlange, damit es genau EINE Liste gibt.
 */
export const RECIPIENT_RELATED_CLASSES: readonly ErrorClass[] = [
  'empfaenger_abgewiesen',
];

/** Zählt ein Fehlschlag dieser Klasse gegen die Empfängeradresse? */
export function isRecipientRelated(errorClass: string | null | undefined): boolean {
  return (
    errorClass !== null &&
    errorClass !== undefined &&
    (RECIPIENT_RELATED_CLASSES as readonly string[]).includes(errorClass)
  );
}

/** Netzwerk- und Verbindungscodes, die nodemailer und Node selbst werfen. */
const CONNECTION_CODES = new Set([
  'ECONNECTION',
  'ETIMEDOUT',
  'ESOCKET',
  // Namensauflösung. FEHLTE und war der Kern von [K1]: nodemailer meldet einen
  // gescheiterten DNS-Lookup als `EDNS`, nicht als `ECONNECTION`.
  'EDNS',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

/**
 * Meldungen, mit denen ein Postausgang UNSEREN ABSENDER abweist.
 *
 * Gebraucht, weil `command` allein nicht reicht — siehe den Block über
 * `klassifiziere`. Die Zeichenketten stammen aus den verbreiteten
 * Absenderbindungen: Postfix (`reject_sender_login_mismatch`), Exim und die
 * grossen Relays formulieren alle in dieser Familie.
 */
const SENDER_REJECTION = [
  'sender address rejected',
  'sender not allowed',
  'sender verify failed',
  'not owned by user',
  'not allowed to send',
  'does not match authenticated user',
  'sender address is not allowed',
];

/**
 * Ordnet einen Nodemailer-Fehler einer Klasse zu.
 *
 * `command` ist bei `EENVELOPE` der ERSTE Anhaltspunkt: nodemailer setzt ihn
 * auf `MAIL FROM` (Absender abgelehnt), `RCPT TO` (Empfänger abgelehnt) oder
 * `API` (nodemailer hat den Umschlag selbst verworfen — also unsere eigene
 * Fehlbedienung).
 *
 * =========================================================================
 * ER IST ABER NICHT DER LETZTE, UND DAS WAR EIN FEHLER [A.30]
 * =========================================================================
 *
 * Gemessen am 07.09.2026 gegen einem Postausgang mit Absenderbindung, mit dem damals
 * vorgegebenen Envelope-From `bounce@example.com`:
 *
 *     code    EENVELOPE
 *     command RCPT TO
 *     text    553 5.7.1 <bounce@example.com>: Sender address rejected:
 *             not owned by user noreply@example.com
 *
 * Der Server sprach über UNSEREN ABSENDER, nodemailer meldete `RCPT TO`. Es
 * bündelt Umschlagfehler und benennt den Befehl, bei dem es aufgab, nicht
 * den, über den der Gegenüber sprach.
 *
 * WARUM DAS MEHR IST ALS EINE FALSCHE ANZEIGE: `empfaenger_abgewiesen` ist
 * die einzige Klasse auf der Whitelist, die gegen die Empfängeradresse
 * zählt — und nach drei Fehlversuchen legt die Rundmail-Warteschlange eine
 * Adresse still, aus `hart_abgewiesen` ohne Rückweg. Ein falsch gesetzter
 * Rückweg hätte so nach drei Rundmails den gesamten Verteiler gelöscht,
 * obwohl kein einziger Empfänger je abgelehnt worden war. Genau dieser
 * Schaden ist unter [K1] schon einmal beschrieben worden; die damalige
 * Lehre — im Zweifel auf UNSERE Seite — wird hier zu Ende geführt.
 *
 * DER MELDUNGSTEXT SCHLÄGT DESHALB DEN BEFEHL, aber nur in EINE Richtung:
 * Er kann eine vermeintliche Empfängerabsage zur Absenderabsage machen, nie
 * umgekehrt. Raten in Richtung „der Empfänger ist schuld" bleibt verboten.
 */
export function classify(error: unknown, message: string): ErrorClass {
  const field = (name: string): unknown =>
    typeof error === 'object' && error !== null
      ? (error as Record<string, unknown>)[name]
      : undefined;
  const code = String(field('code') ?? '');
  const command = String(field('command') ?? '');
  const refused = field('rejected');
  const text = message.toLowerCase();

  if (code === 'EAUTH' || text.includes('invalid login')) return 'login';

  if (code === 'EENVELOPE') {
    // ZUERST: Hat der Gegenüber über UNSEREN Absender gesprochen? Dann ist
    // egal, welchen Befehl nodemailer nennt.
    if (SENDER_REJECTION.some((satz) => text.includes(satz))) {
      return 'absender_abgewiesen';
    }
    // NUR wenn der Gegenüber nachweislich über den EMPFÄNGER gesprochen hat.
    if (command === 'RCPT TO') return 'empfaenger_abgewiesen';
    if (Array.isArray(refused) && refused.length > 0) {
      return 'empfaenger_abgewiesen';
    }
    if (field('recipient') !== undefined) return 'empfaenger_abgewiesen';
    if (command === 'MAIL FROM') return 'absender_abgewiesen';
    // `API` und alles Übrige: unsere Seite. Bewusst NICHT als
    // Empfängerabsage — es gibt keinen Beleg dafür.
    return 'unknown';
  }

  if (text.includes('starttls') || text.includes('tls') || text.includes('ssl')) {
    return 'tls';
  }

  if (
    CONNECTION_CODES.has(code) ||
    text.includes('getaddrinfo') ||
    text.includes('greeting') ||
    text.includes('connect') ||
    text.includes('timeout')
  ) {
    return 'verbindung';
  }

  return 'unknown';
}

/** Ein aufgebauter Versandweg samt der Frage, ob er wirklich versendet. */
interface Transport {
  transporter: nodemailer.Transporter;
  sender: string;
}

/**
 * Welche Absenderadresse eine Transaktionsmail trägt.
 *
 * Bewusst nur zwei Werte und KEIN Wert für den werblichen Kanal: Der liegt in
 * einem eigenen Dienst (`rundmail/werbemail.service.ts`). Ein dritter Wert
 * hier wäre der Schalter, den R3 ausschliesst.
 */
type SenderKind = 'admin' | 'invoice';

/**
 * Der Versand einer Mail ist fehlgeschlagen.
 *
 * ERREICHT DIE ANONYME ANFORDERUNGSROUTE NICHT MEHR. Dort läuft der Versand
 * seit [K2] außerhalb des Antwortpfads; diese Ausnahme wird dort gefangen,
 * protokolliert und verworfen, und der Aufrufer bekommt in jedem Fall dieselbe
 * `200`-Antwort. Eine frühere Fassung reichte sie durch und machte die Route
 * damit zu einem Kontoverzeichnis auf Zuruf.
 *
 * Sichtbar wird ein kaputter Postausgang stattdessen an drei Stellen, die alle
 * nicht anonym sind: im Anwendungslog, im Audit-Log und unter
 * `GET /api/zugang/postausgang` (hinter der Sitzung, und nur als Fehlerklasse).
 *
 * Geworfen wird sie weiterhin auf den Routen, die aus einer SITZUNG heraus
 * versenden (`faktoren/email-code/einrichten`) — dort gibt es keine Existenz
 * zu verbergen, und die Betreiberin soll erfahren, dass nichts hinausging.
 */
export class MailSendError extends BusinessError {
  constructor() {
    super(
      'mail_versand_fehlgeschlagen',
      'Die E-Mail konnte nicht versendet werden. Bitte später erneut versuchen.',
      HttpStatus.BAD_GATEWAY,
    );
  }
}

/**
 * ===========================================================================
 * VORSCHAUTEXTE FÜR MAILS, DIE EIN GEHEIMNIS ENTHALTEN
 * ===========================================================================
 *
 * Der Rahmen leitet den Vorschautext sonst aus den ersten ~90 Zeichen des
 * Wortlauts ab. Das ist für fast alle Mails richtig und für genau diese beiden
 * falsch: In der einen steht der Anmeldecode, in der anderen das
 * Demo-Passwort, und der Vorschautext ist das, was ein Telefon auf dem
 * Sperrbildschirm anzeigt.
 *
 * Sie sagen deshalb, WAS die Mail ist, und nicht, was drinsteht.
 */
export const PREHEADER_LOGIN_CODE =
  'Der angeforderte Anmeldecode steht in dieser Nachricht.';

/**
 * Vorschautext der Mail mit dem Aufnahmelink — OHNE den Link.
 *
 * Dieselbe Überlegung wie beim Anmeldecode: Der Vorschautext ist das, was ein
 * Telefon auf dem Sperrbildschirm anzeigt, und der Link ist ein Zugang.
 */
export const PREHEADER_INTAKE =
  'Ein Link zum Ergänzen eurer Angaben steht in dieser Nachricht.';

/**
 * Vorschautext der Mail mit dem Einrichtungslink — OHNE den Link.
 *
 * Dieser Link macht zur Verwaltung einer ganzen Installation. Er gehört in den
 * Mailtext, nicht auf den Sperrbildschirm eines Telefons.
 */
export const PREHEADER_SETUP =
  'Der Link zur Einrichtung eurer Instanz steht in dieser Nachricht.';

/** Vorschautext der Demo-Zugangsmail — ohne das Passwort. */
export const PREHEADER_DEMO =
  'Die Zugangsdaten für die Demo stehen in dieser Nachricht.';

/**
 * Betreff der Demo-Zugangsmail.
 *
 * Steht hier als Konstante, weil das Versandkontingent aus [W2] danach zählt —
 * ein abweichender Betreff an zwei Stellen hätte das Kontingent lautlos
 * wirkungslos gemacht.
 */
export const DEMO_SUBJECT = 'Deine Demo-Zugangsdaten';

/**
 * Betreff der Eingangsbestätigung einer Pilotphase-Anfrage.
 *
 * Konstante aus demselben Grund wie `DEMO_BETREFF`: Das Kontingent zählt
 * danach. Ein zweiter Wortlaut an anderer Stelle machte es wirkungslos.
 */
export const PILOT_SUBJECT = 'Eure Anfrage ist angekommen';

/**
 * Betreff der Mail mit dem Aufnahmelink.
 *
 * Konstante, weil die Karte in der Verwaltung an ihr ablesen können soll,
 * dass diese Mail hinausging — und weil zwei Wortlaute an zwei Stellen
 * auseinanderlaufen.
 */
export const INTAKE_SUBJECT =
  'Bitte ergänzt noch ein paar Angaben';

/**
 * Betreff der Mail mit dem Einrichtungslink einer Kundeninstanz.
 *
 * Konstante, weil die Versandzeile ihn trägt und die Verwaltung daran
 * erkennt, dass diese Mail hinausging.
 */
export const SETUP_SUBJECT = 'Eure Instanz ist bereit';

/**
 * Betreff der Bestätigungsmail des Double-Opt-in.
 *
 * Als Konstante, weil `kanaltrennung.spec.ts` prüft, dass genau diese Mail
 * über den Transaktionskanal geht und keine Abmeldefusszeile trägt.
 */
export const CONSENT_SUBJECT =
  'Bitte bestätige deine E-Mail-Adresse';

/**
 * Die Zugangsdaten der öffentlichen Demo sind nicht eingerichtet.
 *
 * Kein Vorgabewert im Quelltext ([H4]): Ein Passwort im Repository ist auch
 * dann eines, wenn es nur die Demo betrifft. Und eine Vorgabe hätte
 * weitergewirkt, ohne dass jemand die fehlende Konfiguration bemerkt.
 */
export class DemoAccessNotSetUpError extends BusinessError {
  constructor() {
    super(
      'demo_zugang_nicht_eingerichtet',
      'Die Zugangsdaten der Demo sind nicht hinterlegt.',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

/**
 * Mailversand der Verwaltung per Nodemailer.
 *
 * Vorbild und Verhalten wie `apps/api/src/mail/mail.service.ts`: die
 * SMTP-Zugangsdaten kommen aus den Env-Variablen SMTP_*. Fehlt `SMTP_HOST`,
 * wird `jsonTransport` benutzt und die Mail samt Code nur in die Server-Konsole
 * geschrieben — der Entwicklungsmodus mit Mailpit (SMTP 1025, Oberfläche 8025).
 *
 * Anders als in `apps/api` gibt es hier KEINE Konfiguration aus der Datenbank:
 * die Verwaltung hat kein Setup-Formular für SMTP, sie liest ausschließlich die
 * Umgebung.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  /** Nur einmal warnen, nicht bei jedem Versand. */
  private tlsWarningShown = false;
  /**
   * Letzter Versandfehler, für die AUTHENTIFIZIERTE Betriebsanzeige.
   *
   * Der Ort, an dem ein kaputter Postausgang sichtbar wird — die anonyme
   * Anforderungsroute darf ihn nicht verraten ([W1] Runde 1), und `/api/health`
   * darf es auch nicht, denn der Endpunkt ist anonym erreichbar ([K2]).
   * Bewusst im Speicher und nicht in der Datenbank: es ist eine
   * Betriebsanzeige, kein Nachweis. Der Nachweis steht im Audit-Log und im
   * Anwendungslog.
   */
  private lastError: { timestamp: Date; errorClass: ErrorClass } | null = null;

  constructor(private readonly config: ConfigService) {}

  /**
   * Betriebsstand des Postausgangs. NUR hinter Authentifizierung ausgeben.
   *
   * Gibt die Fehler-KLASSE heraus, niemals die rohe Meldung des Relays. Eine
   * Absage wie „550 5.1.1 <geheime.chefin@example.com> rejected" enthält die
   * Zustelladresse des zweiten Faktors im Klartext; die gehört in kein
   * API-Feld, auch nicht in ein authentifiziertes ([K2]). Der volle Wortlaut
   * steht im Anwendungslog, wo er hingehört.
   */
  sendState(): {
    configured: boolean;
    tlsEnforced: boolean;
    lastError: { timestamp: string; errorClass: ErrorClass } | null;
  } {
    return {
      configured: Boolean(this.config.get<string>('SMTP_HOST')),
      tlsEnforced: this.config.get<string>('SMTP_TLS_ERZWINGEN', '1') !== '0',
      lastError: this.lastError
        ? {
            timestamp: this.lastError.timestamp.toISOString(),
            errorClass: this.lastError.errorClass,
          }
        : null,
    };
  }

  /**
   * Baut den Transport pro Versand — eine geänderte Umgebung wirkt sofort.
   *
   * Die SMTP-Einzelheiten (Port, STARTTLS-Pflicht, Anmeldung) stehen seit
   * Etappe 5 in `transport.ts` und werden vom werblichen Kanal ebenfalls von
   * dort gelesen. Getrennt sind die ENTSCHEIDUNGEN der beiden Kanäle (R3),
   * nicht der Verbindungsaufbau: eine zweite Abschrift der
   * Verschlüsselungspflicht wäre eine zweite Stelle, an der sie fehlen kann.
   */
  private transport(senderKind: SenderKind = 'admin'): Transport {
    const addresses = senderAddresses(this.config);
    // SMTP_FROM bleibt der Vorrang für den allgemeinen Verwaltungsversand;
    // Rechnungen gehen von einer EIGENEN Adresse hinaus, damit sich ihre
    // Zustellbarkeit von der der Rundmails trennen lässt.
    const sender =
      senderKind === 'invoice' ? addresses.invoice : addresses.admin;

    if (!transportEnvironment(this.config).tlsEnforced && !this.tlsWarningShown) {
      this.tlsWarningShown = true;
      this.logger.warn(
        'SMTP_TLS_ERZWINGEN=0: Anmeldecodes und SMTP-Zugangsdaten können ' +
          'unverschlüsselt übertragen werden. Nur für lokale Entwicklung ' +
          '(Mailpit ohne STARTTLS) vorgesehen.',
      );
    }

    return { sender, transporter: buildTransport(this.config) };
  }

  /**
   * Verschickt den achtstelligen Anmeldecode.
   *
   * Der Code steht im Klartext IM MAILTEXT — dort gehört er hin. Er landet
   * darüber hinaus nur dann in einem Log, wenn gar kein SMTP konfiguriert ist
   * (Entwicklungsmodus). Ins Audit-Log kommt er nie.
   */
  async sendLoginCode(
    email: string,
    code: string,
    validMinutes: number,
    forSetup: boolean,
  ): Promise<void> {
    const name = mailBrand().name;
    const subject = forSetup
      ? `${name} Verwaltung – Adresse für Anmeldecodes bestätigen`
      : `${name} Verwaltung – Anmeldecode`;
    const introduction = forSetup
      ? 'du möchtest künftig Anmeldecodes an diese Adresse bekommen. Bestätige das mit diesem Code:'
      : `für die Anmeldung in der ${name}-Verwaltung wurde ein Code angefordert:`;
    const text =
      `Hallo,\n\n${introduction}\n\n` +
      `    ${code}\n\n` +
      `Der Code ist ${validMinutes} Minuten gültig und lässt sich genau einmal ` +
      `verwenden. Nach ${CODE_MAX_FAILED_ATTEMPTS} Fehleingaben verfällt er und ` +
      `muss neu angefordert werden.\n\n` +
      `Ohne dein Passwort nützt dieser Code niemandem. Hast du ihn nicht ` +
      `angefordert, ignoriere diese E-Mail — und ändere im Zweifel dein ` +
      `Passwort.\n`;

    await this.send(
      email,
      subject,
      text,
      'Anmeldecode',
      undefined,
      'admin',
      // AUSDRÜCKLICH GESETZT, weil der abgeleitete Vorschautext hier den CODE
      // enthielte. Gemessen an Mailpit: „Hallo, für die Anmeldung in der
      // Verwaltung wurde ein Code angefordert: 12345678…" — genau
      // diese Zeile zeigt das Postfach in der Liste und, schlimmer, das
      // Telefon auf dem SPERRBILDSCHIRM. Der zweite Faktor wäre damit für
      // jeden lesbar, der das Gerät in die Hand nimmt, ohne es zu entsperren.
      PREHEADER_LOGIN_CODE,
    );
    if (!this.config.get<string>('SMTP_HOST')) {
      // Nur ohne SMTP_HOST UND nur außerhalb der Produktion: Der Code ist der
      // zweite Faktor und gehört nie in ein Produktionslog (das Coolify jedem
      // zeigt, der die Anwendung öffnen darf). In der Produktion steht nur
      // der Hinweis, dass keine Mail ging.
      if (this.config.get<string>('NODE_ENV') !== 'production') {
        this.logger.log(`[DEV-MAIL] Anmeldecode an ${email}: ${code}`);
      } else {
        this.logger.warn(
          `Anmeldecode an ${email} NICHT gesendet: SMTP_HOST fehlt.`,
        );
      }
    }
  }

  /**
   * Warnt die BISHERIGE Zustelladresse, dass jemand die Adresse für
   * Anmeldecodes umstellen will ([W3]).
   *
   * Enthält KEINEN Code — sie geht an ein Postfach, das den Wechsel gerade
   * nicht bestätigen soll. Ihr Zweck ist allein, dass die Betreiberin einen
   * fremden Wechselversuch mitbekommt, solange er noch unbestätigt ist.
   */
  async sendAddressChangeNote(
    previous: string,
    newAddress: string,
  ): Promise<void> {
    const text =
      `Hallo,\n\n` +
      `für dein Konto in der ${mailBrand().name}-Verwaltung wurde beantragt, Anmeldecodes ` +
      `künftig an eine ANDERE Adresse zu schicken:\n\n` +
      `    bisher: ${previous}\n` +
      `    neu:    ${newAddress}\n\n` +
      `Der Wechsel ist noch NICHT wirksam — er gilt erst, wenn der an die neue ` +
      `Adresse geschickte Code dort bestätigt wird.\n\n` +
      `Warst du das nicht, handle sofort: ändere dein Passwort und melde unter ` +
      `„Einstellungen → Geräte" alle Geräte ab. Jemand hat dann Zugriff auf ` +
      `deine angemeldete Sitzung.\n`;
    await this.send(
      previous,
      `${mailBrand().name} Verwaltung – Achtung: Adresse für Anmeldecodes soll geändert werden`,
      text,
      'Adresswechsel-Hinweis',
    );
    if (!this.config.get<string>('SMTP_HOST')) {
      this.logger.log(
        `[DEV-MAIL] Adresswechsel-Hinweis an ${previous} (neu: ${newAddress})`,
      );
    }
  }

  /**
   * Benachrichtigt die BETREIBERIN über eine neu eingegangene Anfrage.
   *
   * Das ist die Redundanz, wegen der es diese Mail überhaupt gibt: Die Anfrage
   * steht bereits in der Datenbank. Wäre das CRM nachts nicht erreichbar oder
   * fiele es aus, läge die Anfrage trotzdem im Postfach. Deshalb wird sie
   * ZUSÄTZLICH verschickt und nicht statt der Speicherung.
   *
   * Wortlaut und Aufbau übernehmen `sendeInterneAnfrage` aus `apps/api`; das
   * Postfach der Betreiberin soll nach dem Umzug nicht anders aussehen.
   */
  async sendInquiryNotification(
    recipient: string,
    subject: string,
    rows: string[],
  ): Promise<void> {
    const text = rows.join('\n') + '\n';
    await this.send(
      recipient,
      `${mailBrand().name} – ${subject}`,
      text,
      `Anfrage-Benachrichtigung (${subject})`,
    );
    if (!this.config.get<string>('SMTP_HOST')) {
      this.logger.log(`[DEV-MAIL] Anfrage-Benachrichtigung an ${recipient}`);
    }
  }

  /**
   * Bestätigt den EINGANG einer Pilotphase-Anfrage bei den Anfragenden.
   *
   * =======================================================================
   * WARUM ES DIESE MAIL GIBT
   * =======================================================================
   *
   * Der Dialog auf der Webseite sagt seit jeher „eine Bestätigung liegt
   * bereits in eurem Postfach" — und es ging keine hinaus. Zwei Auswege gab
   * es: den Satz streichen oder die Mail bauen. Gebaut wird sie, weil sie
   * das Einzige ist, was einer anfragenden Organisation belegt, dass ihr
   * Formular nicht ins Leere lief; das Formular meldet aus Absicht auch dann
   * „gesendet", wenn hier etwas schiefgeht ([kein Aufzählungskanal]).
   *
   * SIE IST EINE TRANSAKTIONSMAIL und keine Werbung (R3): Sie beantwortet
   * eine Handlung der Empfängerin, wirbt für nichts und trägt keine
   * Abmeldefusszeile. Der Rundmail-Kanal bleibt unberührt — dafür gibt es
   * das Häkchen im Formular und die Bestätigungsmail des Double-Opt-in.
   *
   * SIE ENTHÄLT KEINE ANGABEN AUS DEM FORMULAR. Das ist kein Sparen am
   * Wortlaut, sondern dieselbe Überlegung wie beim Demo-Zugang: Wer eine
   * fremde Adresse einträgt, soll dieser Adresse nicht auch noch den
   * mitgeschickten Text zustellen können. Bestätigt wird, DASS etwas
   * ankam — nicht, was.
   */
  async sendInquiryConfirmation(email: string): Promise<void> {
    const text =
      'Hallo,\n\neure Anfrage zur Pilotphase von ' +
      mailBrand().name +
      ' ist bei uns ' +
      'angekommen. Wir sehen sie uns an und melden uns innerhalb weniger ' +
      'Tage bei euch.\n\nDie Instanz ' +
      'richten wir für euch ein.\n\nWenn ihr in der Zwischenzeit etwas ' +
      'ergänzen wollt, antwortet einfach auf diese Nachricht.\n';
    await this.send(email, PILOT_SUBJECT, text, 'Anfrage-Bestätigung');
    if (!this.config.get<string>('SMTP_HOST')) {
      this.logger.log(`[DEV-MAIL] Anfrage-Bestätigung an ${email}`);
    }
  }

  /**
   * Schickt den Link zum Aufnahmeformular.
   *
   * =======================================================================
   * DIE EINZIGE MAIL DIESES HAUSES, DIE EINEN ZUGANG TRÄGT
   * =======================================================================
   *
   * Der Link führt zu einem Formular, in das eine IBAN eingetragen wird. Er
   * geht deshalb ausschliesslich an `ansprechpartnerinEmail` — also an die
   * Adresse, die bereits im Datensatz steht und die die Betreiberin bewusst
   * dort eingetragen hat. Er wird NIE an eine Adresse geschickt, die aus einem
   * Formular kommt.
   *
   * KEIN VORSCHAUTEXT MIT DEM LINK. Er steht im Mailtext, wo er hingehört,
   * aber nicht in der Zeile, die ein Telefon auf dem Sperrbildschirm anzeigt —
   * dieselbe Überlegung wie beim Anmeldecode und beim Demo-Passwort.
   */
  async sendIntakeLink(
    email: string,
    companyName: string,
    link: string,
    validDays: number,
  ): Promise<void> {
    const text =
      `Hallo,\n\nschön, dass ${companyName} bei der Pilotphase von ` +
      mailBrand().name + ' dabei ist. Damit wir eure Instanz einrichten und euch ' +
      'Rechnungen schicken können, brauchen wir noch ein paar Angaben.\n\n' +
      'Über diesen Link könnt ihr sie selbst eintragen — das dauert ein paar ' +
      'Minuten und ihr könnt zwischendurch abbrechen:\n\n' +
      `${link}\n\n` +
      `Der Link ist ${validDays} Tage gültig und lässt sich einmal ` +
      'ausfüllen. Wenn die Frist abläuft, schicken wir gern einen neuen.\n';
    await this.send(
      email,
      INTAKE_SUBJECT,
      text,
      'Aufnahmelink',
      undefined,
      'admin',
      PREHEADER_INTAKE,
    );
    if (!this.config.get<string>('SMTP_HOST')) {
      this.logger.log(`[DEV-MAIL] Aufnahmelink an ${email}`);
    }
  }

  /**
   * Schickt den Einrichtungslink einer frischen Kundeninstanz — mit kurzer
   * Anleitung.
   *
   * DIE SCHRITTE SIND DIE DES ASSISTENTEN, nicht ausgedacht: Organisation,
   * Hauptdomäne, Startpersonen, Zusammenfassung (`apps/web/src/pages/
   * SetupWizard.tsx`, `SCHRITTE`). Der SMTP-Schritt fehlt, weil jede Instanz
   * ihren Postausgang aus der Umgebung bekommt. Ändert sich der Assistent,
   * muss dieser Text mit — sonst beschreibt die Mail einen Weg, den es nicht
   * gibt.
   *
   * KEIN PASSWORT IM ASSISTENTEN: Die drei Startpersonen bekommen danach je
   * eine Einladung und legen ihr Passwort selbst fest. Die Mail sagt das,
   * damit niemand im Assistenten nach einem Passwortfeld sucht.
   */
  async sendSetupLink(
    email: string,
    companyName: string,
    link: string,
    instanceUrl: string,
  ): Promise<void> {
    const text =
      `Hallo,\n\ndie ${mailBrand().name}-Instanz für ${companyName} ist bereit:\n\n` +
      `  ${instanceUrl}\n\n` +
      'Mit dem folgenden Link richtet ihr sie ein. Wer ihn öffnet, legt die ' +
      'ersten Personen an und bestimmt damit, wer die Instanz verwaltet — ' +
      'bitte gebt ihn deshalb nicht weiter:\n\n' +
      `${link}\n\n` +
      'Die Einrichtung dauert etwa zehn Minuten und hat vier Schritte:\n\n' +
      `  1. Organisation — der Name, unter dem ihr in ${mailBrand().name} erscheint.\n` +
      '  2. Hauptdomäne — Name, Ziel und Aufgaben eures ersten Kreises.\n' +
      '  3. Startpersonen — drei Personen mit Name und E-Mail-Adresse: eine ' +
      'für die Verwaltung (Admin), eine für die Moderation und eine ' +
      'teilhabende Person.\n' +
      '  4. Zusammenfassung — prüfen und abschließen.\n\n' +
      'Danach bekommen die drei Startpersonen je eine Einladung per E-Mail, ' +
      'mit der sie ihr eigenes Passwort festlegen. Der Link gilt, bis die ' +
      'Einrichtung abgeschlossen ist; danach ist er gesperrt, und angemeldet ' +
      `wird sich unter ${instanceUrl}.\n\n` +
      'Fragen? Antwortet einfach auf diese Mail.\n';
    await this.send(
      email,
      SETUP_SUBJECT,
      text,
      'Einrichtungslink',
      undefined,
      'admin',
      PREHEADER_SETUP,
    );
    if (!this.config.get<string>('SMTP_HOST')) {
      this.logger.log(`[DEV-MAIL] Einrichtungslink an ${email}`);
    }
  }

  /**
   * Schickt die Zugangsdaten der öffentlichen Demo.
   *
   * WORTGLEICH ZU `apps/api/src/mail/mail.service.ts` (`sendeDemoZugang`), nur
   * ohne HTML-Teil — `apps/control` verschickt durchgehend reinen Text. Der
   * automatische Versand bleibt ausdrücklich bestehen; er ist der Grund, warum
   * eine Demo-Anfrage nachts sofort beantwortet ist.
   *
   * Die Zugangsdaten sind für ALLE gleich und stehen bewusst in der Umgebung,
   * nicht im Code: die Demo wird stündlich zurückgesetzt, es gibt dort nichts
   * zu schützen.
   */
  async sendDemoAccess(email: string): Promise<void> {
    // Betreff als Konstante, weil das Kontingent aus [W2] danach zählt.
    const url = this.config.get<string>('DEMO_URL');
    const user = this.config.get<string>('DEMO_LOGIN_USER');
    const password = this.config.get<string>('DEMO_LOGIN_PASS');
    // KEINE Vorgabe im Quelltext ([H4]). Ein Passwort, das im Repository
    // steht, ist auch dann eines, wenn es „nur die Demo" ist — und die
    // Vorgabe wirkte lautlos weiter, wenn die Umgebung vergessen wurde. Ohne
    // Konfiguration geht die Mail lieber gar nicht hinaus; der Aufrufer
    // meldet das (siehe OeffentlichService.benachrichtige).
    if (!url || !user || !password) {
      throw new DemoAccessNotSetUpError();
    }
    const text =
      `Hallo,\n\nschön, dass du ${mailBrand().name} ausprobieren möchtest. Hier deine ` +
      `Zugangsdaten für die Demo:\n\n` +
      `  Adresse:    ${url}\n  Nutzername: ${user}\n  Passwort:   ${password}\n\n` +
      `Die Demo ist eine echte Instanz mit erfundenen Daten. Probier alles aus – ` +
      `alle Änderungen werden stündlich automatisch zurückgesetzt.\n`;
    await this.send(
      email,
      DEMO_SUBJECT,
      text,
      'Demo-Zugang',
      undefined,
      'admin',
      // Dieselbe Überlegung wie beim Anmeldecode: In diesem Text steht ein
      // Passwort. Dass der abgeleitete Ausschnitt heute davor endet, ist ein
      // Zufall der Satzlänge und keine Zusicherung.
      PREHEADER_DEMO,
    );
    if (!this.config.get<string>('SMTP_HOST')) {
      this.logger.log(`[DEV-MAIL] Demo-Zugang an ${email}`);
    }
  }

  /**
   * Verschickt eine RECHNUNG als Transaktionsmail — mit dem PDF im Anhang.
   *
   * Transaktionsmail und nicht werblich: Sie ist die Erfüllung eines
   * Vertrages und braucht keine Einwilligung. Der Kanal steht so auch auf dem
   * `MailVersand`-Nachweis, den der Aufrufer schreibt.
   *
   * DER ANHANG IST DAS GEPRÜFTE DOKUMENT. Er wird hier nicht erzeugt und
   * nicht verändert — er kommt fertig aus dem Rechnungsdienst, der ihn selbst
   * gegen veraPDF und Schematron geprüft hat.
   */
  async sendInvoice(
    email: string,
    subject: string,
    text: string,
    attachment: { filename: string; content: Buffer },
  ): Promise<void> {
    await this.send(email, subject, text, 'Rechnung', attachment, 'invoice');
    if (!this.config.get<string>('SMTP_HOST')) {
      this.logger.log(`[DEV-MAIL] Rechnung an ${email} (${attachment.filename})`);
    }
  }

  /**
   * Zahlungserinnerung — freundlich, ohne Mahngebühr, ohne Fristsetzung.
   *
   * Der Wortlaut steht als Vorlage im Quelltext, wie bei allen anderen Mails
   * dieses Dienstes. Er gehört bewusst NICHT in die Tabelle `MailVorlage`:
   * Diese Tabelle ist Etappe 5, und eine Vorlage in der Datenbank, die
   * niemand pflegen kann, weil es dafür noch keine Oberfläche gibt, wäre ein
   * Wortlaut ohne Autor. Der Umzug dorthin ist ein Handgriff, sobald es die
   * Oberfläche gibt.
   *
   * Der Anhang ist optional: Eine Erinnerung ohne die Rechnung nötigt die
   * Empfängerin, in ihrem Postfach zu suchen.
   */
  async sendPaymentReminder(
    email: string,
    subject: string,
    text: string,
    attachment?: { filename: string; content: Buffer },
  ): Promise<void> {
    await this.send(
      email,
      subject,
      text,
      'Zahlungserinnerung',
      attachment,
      'invoice',
    );
    if (!this.config.get<string>('SMTP_HOST')) {
      this.logger.log(`[DEV-MAIL] Zahlungserinnerung an ${email}`);
    }
  }

  /**
   * DIE BESTÄTIGUNGSMAIL DES DOUBLE-OPT-IN — und warum sie hier steht.
   *
   * Sie geht über den TRANSAKTIONSKANAL, obwohl es um einen Newsletter geht.
   * Das ist kein Schlupfloch, sondern die einzige mögliche Einordnung: Sie
   * enthält keine Werbung, sondern genau eine Frage („warst du das?") und den
   * Link, mit dem sich die Frage beantworten lässt. Ohne sie gäbe es kein
   * bestätigtes Opt-in — sie wäre also die Voraussetzung ihrer eigenen
   * Voraussetzung. Der BGH sieht das genauso: die reine Anforderung einer
   * Bestätigung ist keine Werbung.
   *
   * WAS SIE DESHALB NICHT ENTHALTEN DARF: kein Produkthinweis, kein
   * „übrigens", kein Angebot. Der Wortlaut steht hier im Code und nicht in
   * `MailVorlage`, damit niemand ihn im Redaktionsbereich in eine Werbemail
   * verwandeln kann.
   *
   * KEIN `MailVersand`-EINTRAG. Das ist Absicht: Eine unbestätigte Eintragung
   * wird nach 72 Stunden gelöscht. Stünde die Adresse zusätzlich in einer
   * Versandzeile, überlebte sie die Löschung, und die Löschung wäre eine
   * Behauptung. Der Nachweis dieser Mail ist der Token in der
   * Einwilligungszeile — und der verschwindet mit ihr.
   */
  async sendConsentConfirmation(
    email: string,
    confirmationLink: string,
    validHours: number,
  ): Promise<void> {
    const text =
      `Hallo,\n\n` +
      `für diese Adresse wurde der ${mailBrand().name}-Newsletter angefordert. Damit ` +
      `wir dir schreiben dürfen, brauchen wir eine Bestätigung von dir:\n\n` +
      `    ${confirmationLink}\n\n` +
      `Der Link ist ${validHours} Stunden gültig. Wird er nicht benutzt, ` +
      `löschen wir die Eintragung wieder — vollständig und ohne Rückfrage.\n\n` +
      `Warst du das nicht, musst du nichts tun. Ohne deinen Klick geht von ` +
      `uns keine einzige Mail an diese Adresse.\n`;
    await this.send(email, CONSENT_SUBJECT, text, 'Einwilligung');
    if (!this.config.get<string>('SMTP_HOST')) {
      this.logger.log(`[DEV-MAIL] Bestätigungslink an ${email}`);
    }
  }

  /**
   * Verschickt und merkt sich den Fehlschlag für `/api/health`.
   *
   * `betreffArt` statt des Betreffs im Log: der Betreff kann eine Adresse
   * enthalten, die Betriebsanzeige braucht nur die Art.
   */
  private async send(
    email: string,
    subject: string,
    text: string,
    subjectKind: string,
    attachment?: { filename: string; content: Buffer },
    senderKind: SenderKind = 'admin',
    preheader?: string,
  ): Promise<void> {
    const { transporter, sender } = this.transport(senderKind);
    const addresses = senderAddresses(this.config);
    // DER RAHMEN. Aus demselben Wortlaut entstehen beide Teile: der HTML-Teil
    // fuer die Anzeige, der Textteil fuer alles, was kein HTML zeigt oder
    // zeigen will. `transaktionsRahmen` hat keinen Parameter fuer eine
    // Fusszeile — hier kann kein Abmeldelink hineingeraten (R3).
    const mail = transactionalLayout({
      subject,
      html: htmlFromText(text),
      text,
      preheader,
    });
    try {
      await transporter.sendMail({
        from: sender,
        to: email,
        replyTo: addresses.replyTo,
        // DER RÜCKWEG (Envelope-From). Muss auf derselben Domäne liegen wie
        // `from`, sonst scheitert die strenge SPF-Ausrichtung (`aspf=s`) —
        // und bei `p=quarantine` landet die Mail im Spam. Ausführlich in
        // `absender.ts` und `docs/operations/billing.md`.
        envelope: { from: addresses.returnPath, to: [email] },
        subject: subject,
        // BEIDE TEILE, immer. Eine reine HTML-Mail ist ein Zustellungsrisiko:
        // viele Spamfilter lesen zuerst den Textteil, manche Programme zeigen
        // ausschliesslich ihn. nodemailer setzt daraus multipart/alternative.
        text: mail.text,
        html: mail.html,
        ...(attachment
          ? {
              attachments: [
                {
                  filename: attachment.filename,
                  content: attachment.content,
                  contentType: 'application/pdf',
                },
              ],
            }
          : {}),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Voller Wortlaut ins Log (für den Betrieb), aber niemals der Code — und
      // in die Betriebsanzeige nur die Klasse, nie der Wortlaut.
      this.logger.error(
        `${subjectKind} an ${email} konnte nicht versendet werden: ${reason}`,
      );
      this.lastError = {
        timestamp: new Date(),
        errorClass: classify(error, reason),
      };
      throw new MailSendError();
    }
    this.lastError = null;
  }
}
