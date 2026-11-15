import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as argon2 from 'argon2';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import type { InquirySource } from '../common/inquiry-source';
import {
  LoginFailedError,
  AccountLockedError,
} from '../common/errors/business-error';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { LoginFlowService } from './login-flow.service';
import {
  CODE_VALID_MS,
  EmailLoginCodeService,
} from './email-login-code.service';
import { reasonOf } from './email-login-code.service';
import type { RedeemResult } from './email-login-code.service';
import { setUpFactors } from './factors';
import type { FactorKind } from './factors';
import { labelFromUserAgent } from './device-label';
import { withMinDuration } from './constant-time-response';
import { DeviceService } from './device.service';
import { PasskeyService } from './passkey.service';
import { SessionService } from './session.service';
import type { SessionUser } from './session.service';
import { LockoutService } from './lockout.service';
import type { LockoutState } from './lockout.service';
import { TotpService } from './totp.service';
import { RecoveryCodeService } from './recovery-code.service';

/** Konto samt allem, was für eine Anmeldeentscheidung gebraucht wird. */
interface LoginAccount extends LockoutState {
  name: string;
  username: string;
  role: string;
  passwordHash: string | null;
  totpSecret: string | null;
  loginCodeEmail: string | null;
  loginCodeEnabled: boolean;
  /** Zugang entzogen? Dann führt KEIN Anmeldeweg mehr hinein. */
  deactivatedAt: Date | null;
  loginFlowGeneration: number;
}

/**
 * Wird beim ersten Bedarf einmal erzeugt und dann wiederverwendet: gegen diesen
 * Hash wird verifiziert, wenn die Kennung unbekannt ist. Ohne das kehrt die
 * Anmeldung bei unbekannter Kennung sofort zurück, während sie bei bekannter
 * Kennung ~100 ms für argon2 braucht — dieser Unterschied ist über das Netz
 * messbar und verrät, welche Konten existieren.
 */
let dummyHash: Promise<string> | null = null;

/**
 * Feste Mindestdauer der anonymen Anforderungsroute.
 *
 * Grosszuegig ueber dem, was der teuerste Zweig braucht (ein argon2-Hash plus
 * zwei bis drei Abfragen, gemessen unter 100 ms). Fuer den Benutzer
 * unmerklich, fuer einen Messenden ununterscheidbar.
 */
export const REQUEST_MIN_DURATION_MS = 250;

/**
 * Verbrennt so viel Rechenzeit wie das Hashen eines Codes.
 *
 * Das Ergebnis wird verworfen — es geht allein um die Dauer. Der Aufruf MUSS
 * bleiben, sonst kehrt der Zweig fuer eine unbekannte Kennung messbar
 * frueher zurueck als der fuer ein echtes Konto.
 */
async function consumedComputeTime(): Promise<void> {
  await argon2.hash(randomBytes(16).toString('hex'), { type: argon2.argon2id });
}

function getDummyHash(): Promise<string> {
  if (!dummyHash) {
    // Inhalt egal, nur die Rechenzeit zählt. Zufällig, damit er nie zufällig
    // zu einer echten Eingabe passt.
    dummyHash = argon2.hash(randomBytes(32).toString('hex'), {
      type: argon2.argon2id,
    });
  }
  return dummyHash;
}

/**
 * Kürzt eine eingegebene, NICHT aufgelöste Kennung für das Audit-Log.
 *
 * Wer sein Passwort versehentlich ins Benutzernamenfeld tippt, hätte es sonst
 * im Klartext im Nachweis stehen — `saeubereFuerAudit` greift dort nicht, weil
 * der Wert im Feld `akteur` und nicht in Vorher/Nachher steht. Für den Zweck
 * „welche Kennung wurde probiert" genügen die ersten Zeichen.
 */
export function maskIdentifier(identifier: string): string {
  const raw = identifier.trim();
  if (raw.length === 0) return '(ohne Kennung)';
  if (raw.length <= 3) return `${raw}…`;
  return `${raw.slice(0, 3)}…(${raw.length} Zeichen)`;
}

/**
 * EIN KONTO OHNE ZUGANG KOMMT NIRGENDS HINEIN.
 *
 * Geprüft auf JEDEM Anmeldeweg, nicht nur beim Passwort: Passkey und
 * E-Mail-Code führen an einem Passworthash vorbei, und ein entzogener Zugang,
 * der über den Passkey noch funktioniert, wäre kein entzogener Zugang.
 *
 * DIE MELDUNG IST DIESELBE WIE BEI EINER FALSCHEN KENNUNG. Wer eine Adresse
 * durchprobiert, soll daran nicht ablesen können, dass es das Konto gibt und
 * es nur abgeschaltet wurde.
 */
function checkNotDeactivated(account: { deactivatedAt: Date | null }): void {
  if (account.deactivatedAt !== null) {
    throw new LoginFailedError();
  }
}

/** Auswahl für alle Kontoabfragen der Anmeldung. */
const ACCOUNT_SELECTION = {
  id: true,
  name: true,
  username: true,
  email: true,
  role: true,
  passwordHash: true,
  totpSecret: true,
  loginCodeEmail: true,
  loginCodeEnabled: true,
  loginFlowGeneration: true,
  failedAttempts: true,
  lockedUntil: true,
  deactivatedAt: true,
} as const;

/**
 * Klartext-Begründung je Fehlschlag beim Einlösen eines E-Mail-Codes — für das
 * Audit-Log. Enthält NIE den Code, nur den Grund.
 */
const REASON_TO_REDEMPTION: Record<
  Exclude<RedeemResult['kind'], 'ok'>,
  string
> = {
  no_code: 'Kein gültiger Code hinterlegt (nicht angefordert oder verbrannt).',
  expired: 'Der Code ist abgelaufen.',
  wrong_purpose: 'Der Code war für die Einrichtung bestimmt, nicht zur Anmeldung.',
  wrong: 'Falscher Code.',
  burned: 'Code durch zu viele Fehlversuche verbrannt.',
};

/** Ergebnis einer abgeschlossenen Anmeldung. */
export interface LoginDone {
  kind: 'session';
  user: SessionUser;
  sessionToken: string;
  /** Neuer Merk-Token, falls ein Gerät angelegt oder rotiert wurde. */
  trustedToken?: string;
}

/** Das Passwort stimmte, der zweite Faktor fehlt noch. */
export interface SecondFactorRequired {
  kind: 'second-factor';
  flowToken: string;
  /**
   * Welche zweiten Faktoren an diesem Konto eingerichtet sind — damit die
   * Oberfläche nur anbietet, was auch funktioniert.
   *
   * Das ist KEIN Kennungs-Leck: hierher kommt nur, wer das Passwort bereits
   * bewiesen hat.
   */
  factors: FactorKind[];
}

/**
 * Die Anmeldewege der Verwaltung.
 *
 * ZWEI Wege, mehr gibt es nicht:
 *
 * 1. **Benutzername oder E-Mail plus Passwort** (Faktor eins), danach
 *    ZWINGEND ein zweiter Faktor. Welcher, wählt der Benutzer bei der
 *    Einrichtung: **achtstelliger Code per E-Mail**, **TOTP-Code aus der
 *    Authenticator-App** — oder ersatzweise ein Wiederherstellungscode, der
 *    jeden der beiden ersetzt. Ein Merk-Gerät überspringt für 30 Tage nur den
 *    zweiten Faktor; das Passwort bleibt IMMER nötig.
 * 2. **Passkey** (WebAuthn) als einstufige Alternative. Phishing-resistent und
 *    in sich zweifaktorig, deshalb ohne zusätzlichen Faktor.
 *
 * Es gibt bewusst KEIN „Passwort vergessen" per E-Mail. Ein vergessenes
 * Passwort wird über das Notfallkommando `emergency password` zurückgesetzt,
 * nicht über einen Selbstbedienungsweg. Der E-Mail-Anmeldecode ist davon zu
 * unterscheiden: er ist ein zweiter FAKTOR und ersetzt niemals das Passwort.
 */
@Injectable()
export class LoginService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly session: SessionService,
    private readonly lockout: LockoutService,
    private readonly passkey: PasskeyService,
    private readonly totp: TotpService,
    private readonly codes: RecoveryCodeService,
    private readonly codesPerMail: EmailLoginCodeService,
    private readonly mail: MailService,
    private readonly devices: DeviceService,
    private readonly flow: LoginFlowService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Löst die eingegebene Kennung auf — wahlweise Nutzername oder E-Mail.
   * Die Kennung ist Pflicht; es gibt keine Auflösung „auf das einzige Konto".
   */
  private async findAccount(identifier: string): Promise<LoginAccount | null> {
    const cleaned = identifier.trim().toLowerCase();
    if (cleaned.length === 0) return null;
    return this.prisma.user.findFirst({
      where: { OR: [{ username: cleaned }, { email: cleaned }] },
      select: ACCOUNT_SELECTION,
    });
  }

  /** Lädt ein Konto über seine ID (für den zweiten Schritt). */
  private async ladeAccount(userId: string): Promise<LoginAccount | null> {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: ACCOUNT_SELECTION,
    });
  }

  /** Merkt sich den erfolgreichen Zugang und gibt die fertige Sitzung zurück. */
  private async placeSessionFrom(account: LoginAccount): Promise<LoginDone> {
    await this.prisma.user.update({
      where: { id: account.id },
      data: {
        failedAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        // Entwertet ALLE offenen Anmeldevorgänge dieses Kontos ([H1]).
        // `increment` statt Zuweisung, damit zwei gleichzeitige Abschlüsse
        // sich nicht gegenseitig überschreiben — dasselbe Muster wie bei
        // `sitzungsGeneration`.
        loginFlowGeneration: { increment: 1 },
      },
    });
    return {
      kind: 'session',
      user: {
        id: account.id,
        name: account.name,
        username: account.username,
        email: account.email,
        role: account.role,
      },
      sessionToken: await this.session.createToken(account.id),
    };
  }

  /**
   * Protokolliert einen Fehlversuch, verbucht ihn auf dem Konto und wirft.
   * Die eingegebene Kennung wird protokolliert, das eingegebene Geheimnis nie.
   */
  private async fail(
    account: LoginAccount | null,
    identifier: string,
    action:
      | typeof AUDIT_ACTION.loginPasswordError
      | typeof AUDIT_ACTION.loginPasskeyError
      | typeof AUDIT_ACTION.loginTotpError
      | typeof AUDIT_ACTION.loginRecoveryError
      | typeof AUDIT_ACTION.loginEmailCodeError,
    reason: string,
    source: InquirySource,
    /**
     * Zählt dieser Fehlschlag auf die Kontosperre?
     *
     * Nur wo ein GEHEIMNIS geraten wurde (Passwort, TOTP-Code,
     * Wiederherstellungscode). Ein fehlgeschlagener Passkey-Versuch ist kein
     * geratenes Geheimnis — würde er zählen, könnte ein Angreifer, der nur den
     * Benutzernamen kennt, die Betreiberin dauerhaft aus dem
     * phishing-resistenten Weg aussperren. Dort bremst allein das Rate-Limit.
     */
    countsOnLockout = true,
    /**
     * Wird als `detail` an den Client durchgereicht. NUR dort setzen, wo der
     * Aufrufer das Passwort bereits bewiesen hat — siehe
     * `AnmeldungFehlgeschlagenFehler`.
     */
    detail?: { reason: string },
  ): Promise<never> {
    let lockoutSeconds = 0;
    if (account && countsOnLockout) {
      lockoutSeconds = await this.lockout.recordFailedAttempt(account, source);
    }

    await this.audit.log({
      userId: account?.id ?? null,
      actor: identifier,
      action,
      objectType: 'User',
      objectId: account?.id ?? null,
      afterValue: { reason, accountKnown: account !== null },
      ip: source.ip,
      userAgent: source.userAgent,
    });

    if (lockoutSeconds > 0) {
      throw new AccountLockedError(lockoutSeconds);
    }
    throw new LoginFailedError(undefined, detail);
  }

  // -------------------------------------------------------------------------
  // Weg 1, Schritt 1: Benutzername oder E-Mail plus Passwort
  // -------------------------------------------------------------------------

  /**
   * Prüft Kennung und Passwort (Faktor eins).
   *
   * Auf einem gültigen Merk-Gerät ist die Anmeldung damit fertig — der zweite
   * Faktor wurde auf diesem Browser bereits vor höchstens 30 Tagen erbracht.
   * Sonst folgt ein zweiter Schritt.
   */
  async passwordLogin(
    identifier: string,
    password: string,
    trustedToken: string | undefined,
    source: InquirySource,
  ): Promise<LoginDone | SecondFactorRequired> {
    const account = await this.findAccount(identifier);

    // Unbekannte Kennung oder Konto ohne Passwort: trotzdem einmal verifizieren.
    // Sonst antwortet der Server hier in Millisekunden und bei einem echten
    // Konto erst nach ~100 ms — daran ließe sich ablesen, welche Konten es gibt.
    // Der Aufruf MUSS bleiben, auch wenn sein Ergebnis verworfen wird.
    if (!account || !account.passwordHash) {
      await argon2.verify(await getDummyHash(), password).catch(() => false);
      throw await this.fail(
        account,
        account ? account.username : maskIdentifier(identifier),
        AUDIT_ACTION.loginPasswordError,
        account
          ? 'Für dieses Konto ist kein Passwort hinterlegt.'
          : 'Kennung nicht auflösbar.',
        source,
        // Zählt NICHT auf die Sperre: hier wurde kein Geheimnis geraten. Für
        // ein Konto ohne Passwort gibt es keines, das man erraten könnte — die
        // Sperre würde nur den Passkey-Weg des Kontos mit blockieren.
        false,
      );
    }
    this.lockout.checkNotLocked(account);
    checkNotDeactivated(account);

    let matches = false;
    try {
      matches = await argon2.verify(account.passwordHash, password);
    } catch {
      // Beschädigter Hash: gilt als falsches Passwort, aber nicht still —
      // der Grund landet im Audit-Log.
      throw await this.fail(
        account,
        account.username,
        AUDIT_ACTION.loginPasswordError,
        'Passwort-Hash konnte nicht geprüft werden.',
        source,
      );
    }
    if (!matches) {
      throw await this.fail(
        account,
        account.username,
        AUDIT_ACTION.loginPasswordError,
        'Falsches Passwort.',
        source,
      );
    }

    const device = await this.devices.recognizeAndRotate(trustedToken, account.id);
    if (!device) {
      // Richtiges Passwort, unbekanntes Gerät: KEIN Fehlversuch — Faktor eins
      // stimmte. Es fehlt nur Faktor zwei.
      await this.audit.log({
        userId: account.id,
        actor: account.username,
        action: AUDIT_ACTION.loginSecondFactorRequired,
        objectType: 'User',
        objectId: account.id,
        afterValue: { reason: 'Gerät nicht als Merk-Gerät hinterlegt.' },
        ip: source.ip,
        userAgent: source.userAgent,
      });
      return {
        kind: 'second-factor',
        flowToken: await this.flow.create({
          type: 'second-factor',
          userId: account.id,
          gen: account.loginFlowGeneration,
        }),
        factors: await this.factorsOf(account),
      };
    }

    const done = await this.placeSessionFrom(account);
    await this.audit.log({
      userId: account.id,
      actor: account.username,
      action: AUDIT_ACTION.loginPasswordSuccess,
      objectType: 'Device',
      objectId: device.deviceId,
      afterValue: {
        label: device.label,
        secondFactorByTrustedDevice: true,
      },
      ip: source.ip,
      userAgent: source.userAgent,
    });
    await this.audit.log({
      userId: account.id,
      actor: account.username,
      action: AUDIT_ACTION.deviceRenewed,
      objectType: 'Device',
      objectId: device.deviceId,
      afterValue: { label: device.label },
      ip: source.ip,
      userAgent: source.userAgent,
    });
    return { ...done, trustedToken: device.newToken };
  }

  /** Liest den laufenden Anmeldevorgang und lädt das zugehörige Konto. */
  private async accountFromFlow(
    flowToken: string | undefined,
  ): Promise<LoginAccount> {
    const flow = await this.flow.read(flowToken, 'second-factor');
    const account = flow.userId
      ? await this.ladeAccount(flow.userId)
      : null;
    // Generation vergleichen: nach einer abgeschlossenen Anmeldung ist dieser
    // Vorgang verbraucht ([H1]). Fehlt `gen`, stammt der Token aus einer
    // früheren Fassung und gilt ebenfalls nicht mehr.
    if (!account || flow.gen !== account.loginFlowGeneration) {
      throw new LoginFailedError(
        'Der Anmeldevorgang ist abgelaufen. Bitte erneut beginnen.',
      );
    }
    this.lockout.checkNotLocked(account);
    checkNotDeactivated(account);
    return account;
  }

  // -------------------------------------------------------------------------
  // Weg 1, Schritt 2a: TOTP als zweiter Faktor
  // -------------------------------------------------------------------------

  /**
   * Schließt die Anmeldung mit dem Code aus der Authenticator-App ab.
   * Auf Wunsch wird der Browser für 30 Tage als Merk-Gerät hinterlegt; der
   * zweite Faktor entfällt dann, das Passwort bleibt weiterhin nötig.
   */
  async secondFactorTotp(
    flowToken: string | undefined,
    code: string,
    deviceRemember: boolean,
    source: InquirySource,
  ): Promise<LoginDone> {
    const account = await this.accountFromFlow(flowToken);

    if (
      !(await this.totp.checkAndConsume(account.id, account.totpSecret, code))
    ) {
      throw await this.fail(
        account,
        account.username,
        AUDIT_ACTION.loginTotpError,
        'Falscher oder abgelaufener Bestätigungscode.',
        source,
      );
    }

    const done = await this.placeSessionFrom(account);
    await this.audit.log({
      userId: account.id,
      actor: account.username,
      action: AUDIT_ACTION.loginTotpSuccess,
      objectType: 'User',
      objectId: account.id,
      afterValue: { deviceRemembered: deviceRemember },
      ip: source.ip,
      userAgent: source.userAgent,
    });

    if (!deviceRemember) {
      return done;
    }
    return { ...done, trustedToken: await this.rememberDevice(account, source) };
  }

  // -------------------------------------------------------------------------
  // Weg 1, Schritt 2b: achtstelliger Code per E-Mail
  // -------------------------------------------------------------------------

  /** Die an diesem Konto eingerichteten zweiten Faktoren. */
  private async factorsOf(account: LoginAccount): Promise<FactorKind[]> {
    const passkeyCount = await this.prisma.passkeyCredential.count({
      where: { userId: account.id },
    });
    return setUpFactors({
      loginCodeEnabled: account.loginCodeEnabled,
      totpSecret: account.totpSecret,
      passkeyCount,
    });
  }

  /**
   * Fordert einen achtstelligen Anmeldecode per E-Mail an.
   *
   * Diese Route ist UNAUTHENTIFIZIERT und darf deshalb unter keinen Umständen
   * verraten, ob es die Kennung gibt. Sie gibt in JEDEM Fall `void` zurück; der
   * Controller antwortet immer gleich. Unterschieden wird nur im Audit-Log.
   *
   * Drei Vorkehrungen dagegen, dass sich die Existenz doch ablesen lässt:
   *
   * 1. Bei unbekannter oder nicht eingerichteter Kennung wird trotzdem einmal
   *    argon2 gerechnet. Ohne das käme die Antwort hier in Millisekunden und
   *    beim echten Konto erst nach ~100 ms — über das Netz gut messbar. Dieselbe
   *    Überlegung wie beim Dummy-Hash der Passwortprüfung.
   * 2. Die 60-Sekunden-Sperre führt NICHT zu einer anderen Antwort. Der alte
   *    Code bleibt gültig, es wird nichts verschickt, fertig.
   * 3. Eine bestehende Kontosperre wird hier BEWUSST nicht geprüft: täte sie
   *    es, verhielte sich ein gesperrtes Konto anders als ein unbekanntes. Der
   *    Code nützt ohnehin nichts, weil das Einlösen die Sperre prüft.
   *
   * OHNE AUSNAHME. Auch ein gescheiterter Mailversand ändert die Antwort nicht:
   * er läuft seit [K2] außerhalb des Antwortpfads, wird dort gefangen und
   * protokolliert. Eine frühere Fassung reichte ihn als `502` durch — damit
   * beantwortete die Route auf Zuruf, ob es ein Konto gibt, sobald der Relay
   * klemmte. Sichtbar wird ein kaputter Postausgang im Anwendungslog, im
   * Audit-Log und unter `GET /api/zugang/postausgang`; alle drei sind nicht
   * anonym erreichbar.
   */
  async requestLoginCode(
    identifier: string,
    source: InquirySource,
  ): Promise<void> {
    await withMinDuration(REQUEST_MIN_DURATION_MS, () =>
      this.requestInner(identifier, source),
    );
  }

  /** Der eigentliche Ablauf. Jeder Zweig rechnet genau EINEN argon2-Hash. */
  private async requestInner(
    identifier: string,
    source: InquirySource,
  ): Promise<void> {
    const account = await this.findAccount(identifier);

    if (!account || !account.loginCodeEnabled) {
      await consumedComputeTime();
      await this.audit.log({
        userId: account?.id ?? null,
        actor: account ? account.username : maskIdentifier(identifier),
        action: AUDIT_ACTION.emailCodeNotSent,
        objectType: 'User',
        objectId: account?.id ?? null,
        afterValue: {
          reason: account
            ? 'Der Faktor „Code per E-Mail" ist an diesem Konto nicht eingerichtet.'
            : 'Kennung nicht auflösbar.',
          accountKnown: account !== null,
        },
        ip: source.ip,
        userAgent: source.userAgent,
      });
      return;
    }

    const target = this.codesPerMail.targetAddress(account);
    // `fordereAn` rechnet den echten Hash IMMER — auch wenn die
    // 60-Sekunden-Sperre danach greift. Damit ist der `zu_frueh`-Zweig kein
    // Schnellweg mehr; genau das war die 6,5-ms-Messung in [K2].
    const result = await this.codesPerMail.request(account.id, target, false);
    if (result.kind === 'too_early') {
      await this.audit.log({
        userId: account.id,
        actor: account.username,
        action: AUDIT_ACTION.emailCodeNotSent,
        objectType: 'EmailLoginCode',
        objectId: account.id,
        afterValue: {
          reason: 'Erneutes Anfordern ist erst nach 60 Sekunden möglich.',
          secondsRemaining: result.secondsRemaining,
        },
        ip: source.ip,
        userAgent: source.userAgent,
      });
      return;
    }

    // Im Nachweis steht, DASS ein Code ging und wohin — niemals der Code.
    await this.audit.log({
      userId: account.id,
      actor: account.username,
      action: AUDIT_ACTION.emailCodeRequested,
      objectType: 'EmailLoginCode',
      objectId: account.id,
      afterValue: {
        recipient: target,
        validMinutes: CODE_VALID_MS / 60_000,
      },
      ip: source.ip,
      userAgent: source.userAgent,
    });

    // DER VERSAND HÄNGT NICHT IM ANTWORTPFAD.
    //
    // Zwei Befunde auf einmal: Der SMTP-Roundtrip machte die Antwort für ein
    // Konto mit E-Mail-Faktor dreimal so lang wie für eine unbekannte Kennung
    // ([K2]), und ein Versandfehler wurde als 502 hinausgereicht, während eine
    // unbekannte Kennung 200 bekam — ein Ja/Nein-Orakel auf Zuruf ([W1]).
    // Beides verschwindet, wenn der Versand die Antwort nicht mehr berührt.
    //
    // Sichtbar bleibt ein kaputter Postausgang trotzdem: im Anwendungslog, im
    // Audit-Log und unter `/api/health` (`mail.letzterFehler`).
    void this.sendConcurrently(
      account.id,
      account.username,
      target,
      result.code,
      result.codeId,
      result.createdAt,
      source,
    );
  }

  /**
   * Verschickt den Code, ohne dass der Aufrufer darauf wartet.
   *
   * Wirft NIE — eine unbehandelte Ablehnung würde den Prozess in Node mit
   * `--unhandled-rejections=throw` beenden. Ein Fehlschlag verwirft den Code,
   * damit die 60-Sekunden-Sperre den Benutzer nicht zusätzlich ausbremst.
   */
  private async sendConcurrently(
    userId: string,
    username: string,
    target: string,
    code: string,
    codeId: string,
    createdAt: Date,
    source: InquirySource,
  ): Promise<void> {
    try {
      await this.mail.sendLoginCode(
        target,
        code,
        CODE_VALID_MS / 60_000,
        false,
      );
    } catch (error) {
      // GENAU diesen Code verwerfen, nicht „den Code des Kontos": bis hierher
      // kann längst ein neuer erzeugt und zugestellt worden sein ([W2]).
      await this.codesPerMail
        .discard(codeId, createdAt)
        .catch(() => undefined);
      await this.audit
        .log({
          userId,
          actor: username,
          action: AUDIT_ACTION.emailCodeNotSent,
          objectType: 'EmailLoginCode',
          objectId: userId,
          afterValue: {
            reason: 'Der Postausgang hat die Mail nicht angenommen.',
            recipient: target,
            error: error instanceof Error ? error.message : String(error),
          },
          ip: source.ip,
          userAgent: source.userAgent,
        })
        .catch(() => undefined);
    }
  }

  /**
   * Schließt die Anmeldung mit dem Code aus der E-Mail ab.
   *
   * Jeder Fehlschlag geht über dieselbe `scheitern`-Strecke wie ein falscher
   * TOTP-Code und zählt damit auf die Kontosperre. Zusätzlich zählt der
   * `EmailAnmeldecodeService` auf dem Code selbst mit und verbrennt ihn nach
   * `CODE_MAX_FEHLVERSUCHE` Versuchen — beide Zähler laufen unabhängig und
   * ersetzen sich nicht. Die Zahl steht hier bewusst nicht ausgeschrieben; als
   * sie es tat, behauptete sie „fünf", während die Konstante längst 3 war ([W9]).
   */
  async secondFactorEmailCode(
    flowToken: string | undefined,
    code: string,
    deviceRemember: boolean,
    source: InquirySource,
  ): Promise<LoginDone> {
    const account = await this.accountFromFlow(flowToken);

    if (!account.loginCodeEnabled) {
      throw await this.fail(
        account,
        account.username,
        AUDIT_ACTION.loginEmailCodeError,
        'Der Faktor „Code per E-Mail" ist an diesem Konto nicht eingerichtet.',
        source,
      );
    }

    const result = await this.codesPerMail.resolve(account.id, code, false);
    if (result.kind !== 'ok') {
      // Der Grund geht als `detail` mit hinaus, damit die Oberfläche „falsch",
      // „verbrannt" und „abgelaufen" auseinanderhalten kann ([DW1]). Hier hat
      // der Aufrufer das Passwort bereits bewiesen — das Cookie `anmeldung`
      // entsteht nur nach erfolgreicher Passwortprüfung —, es wird also nichts
      // verraten, was ein Angreifer an dieser Stelle nicht schon wüsste.
      // `fehlversuche` bleibt bewusst draußen.
      const reason = reasonOf(result);
      throw await this.fail(
        account,
        account.username,
        AUDIT_ACTION.loginEmailCodeError,
        REASON_TO_REDEMPTION[result.kind],
        source,
        true,
        reason ? { reason } : undefined,
      );
    }

    const done = await this.placeSessionFrom(account);
    await this.audit.log({
      userId: account.id,
      actor: account.username,
      action: AUDIT_ACTION.loginEmailCodeSuccess,
      objectType: 'EmailLoginCode',
      objectId: result.codeId,
      beforeValue: { consumed: false },
      afterValue: { consumed: true, deviceRemembered: deviceRemember },
      ip: source.ip,
      userAgent: source.userAgent,
    });

    if (!deviceRemember) {
      return done;
    }
    return { ...done, trustedToken: await this.rememberDevice(account, source) };
  }

  // -------------------------------------------------------------------------
  // Weg 1, Schritt 2b: Wiederherstellungscode statt TOTP
  // -------------------------------------------------------------------------

  /**
   * Schließt die Anmeldung ersatzweise mit einem Wiederherstellungscode ab,
   * wenn die Authenticator-App fehlt. Der Code ist danach verbraucht.
   *
   * Hier wird bewusst KEIN Merk-Gerät angelegt: wer den Ersatzweg gehen muss,
   * soll den zweiten Faktor nicht für 30 Tage überspringen.
   */
  async secondFactorRecoveryCode(
    flowToken: string | undefined,
    code: string,
    source: InquirySource,
  ): Promise<LoginDone> {
    const account = await this.accountFromFlow(flowToken);

    const codeId = await this.codes.resolve(account.id, code);
    if (!codeId) {
      throw await this.fail(
        account,
        account.username,
        AUDIT_ACTION.loginRecoveryError,
        'Code ungültig oder bereits verbraucht.',
        source,
      );
    }

    const done = await this.placeSessionFrom(account);
    const open = await this.codes.countOpen(account.id);
    await this.audit.log({
      userId: account.id,
      actor: account.username,
      action: AUDIT_ACTION.loginRecoverySuccess,
      objectType: 'RecoveryCode',
      objectId: codeId,
      beforeValue: { consumed: false },
      afterValue: { consumed: true, remainingOpen: open },
      ip: source.ip,
      userAgent: source.userAgent,
    });
    return done;
  }

  /** Legt ein Merk-Gerät an und protokolliert das. */
  private async rememberDevice(
    account: LoginAccount,
    source: InquirySource,
  ): Promise<string> {
    const label = labelFromUserAgent('Merk-Gerät', source.userAgent);
    const { deviceId, token } = await this.devices.remember(account.id, label);
    await this.audit.log({
      userId: account.id,
      actor: account.username,
      action: AUDIT_ACTION.deviceCreated,
      objectType: 'Device',
      objectId: deviceId,
      afterValue: { label, validDays: 30 },
      ip: source.ip,
      userAgent: source.userAgent,
    });
    return token;
  }

  // -------------------------------------------------------------------------
  // Weg 2: Passkey (einstufig)
  // -------------------------------------------------------------------------

  /**
   * Startet eine Passkey-Anmeldung.
   *
   * Wertet BEWUSST keine Kennung aus. Diese Route ist unauthentifiziert; würde
   * sie die Passkeys eines Kontos als `allowCredentials` mitgeben, verriete
   * schon die Länge dieser Liste, ob eine Kennung existiert — unauthentifiziert
   * und beliebig oft abfragbar. Die Antwort ist deshalb für jeden Aufrufer
   * gleich, und der Browser wählt selbst unter den auffindbaren Passkeys.
   *
   * Das setzt voraus, dass registrierte Passkeys auffindbar sind — dafür steht
   * `residentKey: 'required'` in `passkey.service.ts`.
   */
  async passkeyStart(): Promise<{
    options: PublicKeyCredentialRequestOptionsJSON;
    flowToken: string;
  }> {
    const options = await this.passkey.loginOptions([]);
    return {
      options,
      // Das Konto steht erst beim Abschluss fest — über die Credential-ID,
      // die der Browser zurückliefert.
      flowToken: await this.flow.create({
        type: 'passkey-login',
        userId: null,
        challenge: options.challenge,
      }),
    };
  }

  /** Schließt eine Passkey-Anmeldung ab. Der Passkey ersetzt beide Faktoren. */
  async passkeyComplete(
    flowToken: string | undefined,
    response: AuthenticationResponseJSON,
    source: InquirySource,
  ): Promise<LoginDone> {
    const flow = await this.flow.read(flowToken, 'passkey-login');
    const challenge = flow.challenge;
    if (!challenge) {
      throw new LoginFailedError(
        'Der Anmeldevorgang ist abgelaufen. Bitte erneut beginnen.',
      );
    }

    const stored = await this.passkey.findViaCredentialId(response.id);
    if (!stored) {
      throw await this.fail(
        null,
        maskIdentifier(response.id),
        AUDIT_ACTION.loginPasskeyError,
        'Unbekannter Passkey.',
        source,
        false,
      );
    }

    const account = await this.ladeAccount(stored.userId);
    if (!account) {
      throw await this.fail(
        null,
        maskIdentifier(response.id),
        AUDIT_ACTION.loginPasskeyError,
        'Konto zum Passkey nicht gefunden.',
        source,
        false,
      );
    }
    // BEWUSST keine Sperrprüfung: die Kontosperre schützt vor dem Raten von
    // Geheimnissen und gilt daher nur für den Passwortpfad. Ein Passkey lässt
    // sich nicht raten. Bliebe der Passkey-Weg gesperrt, könnte ein Angreifer
    // mit fünf Rateversuchen auf das Passwort auch den phishing-resistenten
    // Weg lahmlegen — und die Betreiberin bräuchte Container-Zugriff.
    const ok = await this.passkey.checkLogin(response, challenge, stored);
    if (!ok) {
      throw await this.fail(
        account,
        account.username,
        AUDIT_ACTION.loginPasskeyError,
        'Passkey konnte nicht bestätigt werden.',
        source,
        false,
      );
    }

    const done = await this.placeSessionFrom(account);
    await this.audit.log({
      userId: account.id,
      actor: account.username,
      action: AUDIT_ACTION.loginPasskeySuccess,
      objectType: 'PasskeyCredential',
      objectId: stored.id,
      afterValue: { label: 'Passkey bestätigt' },
      ip: source.ip,
      userAgent: source.userAgent,
    });
    return done;
  }

  /**
   * Meldet ab: die Sitzungs-Generation wird hochgezählt, das Cookie-Token ist
   * damit serverseitig sofort wertlos (auch ein kopiertes). Das beendet
   * zugleich die Sitzungen auf anderen Geräten des Kontos.
   */
  async logout(
    user: SessionUser,
    source: InquirySource,
  ): Promise<void> {
    await this.session.invalidateAllSessions(user.id);
    await this.audit.log({
      userId: user.id,
      actor: user.username,
      action: AUDIT_ACTION.logout,
      objectType: 'User',
      objectId: user.id,
      ip: source.ip,
      userAgent: source.userAgent,
    });
  }
}
