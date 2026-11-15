import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import * as argon2 from 'argon2';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import type { InquirySource } from '../common/inquiry-source';
import {
  LoginFailedError,
  BusinessError,
  AccountLockedError,
  LastFactorError,
} from '../common/errors/business-error';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { LoginFlowService } from './login-flow.service';
import {
  CODE_VALID_MS,
  EmailLoginCodeService,
  reasonOf,
  MESSAGE_WITHOUT_REASON,
  MESSAGE_TO_REASON,
} from './email-login-code.service';
import {
  setUpFactors,
  FACTOR_LABEL,
  factorsAfterRemoval,
  isSetUp,
} from './factors';
import type { FactorKind, FactorBase } from './factors';
import { labelFromUserAgent } from './device-label';
import { DeviceService } from './device.service';
import { PasskeyService } from './passkey.service';
import { SessionService } from './session.service';
import type { SessionUser } from './session.service';
import { LockoutService } from './lockout.service';
import { TotpService } from './totp.service';
import type { TotpSetup } from './totp.service';
import { RecoveryCodeService } from './recovery-code.service';

/**
 * Wie lange nach der Anmeldung eine heikle Aktion ohne erneuten Nachweis
 * zulässig ist: 10 Minuten.
 *
 * Wer sich gerade erst mit der vollständigen Faktorkette ausgewiesen hat, soll
 * das nicht binnen einer Minute noch einmal tun — das wäre Reibung ohne
 * Sicherheitsgewinn. Ein erbeutetes Sitzungs-Cookie ist dagegen praktisch nie
 * frisch: der Angreifer müsste es innerhalb desselben Fensters abgreifen UND
 * verwenden.
 *
 * Tragfähig ist das nur, weil JEDER Weg, der ein Sitzungstoken ausstellt, die
 * vollständige Kette durchlaufen hat: Passwort+TOTP, Passwort+
 * Wiederherstellungscode, Passwort+Merk-Gerät (der zweite Faktor wurde für
 * dieses Gerät früher erbracht), Passkey, oder Notfall-Link+neuer Passkey.
 * Ein Notfall-Passwortlink stellt bewusst gar keine Sitzung aus.
 *
 * Und weil der Zeitpunkt aus `auth_time` kommt und nicht aus `iat`: eine
 * Sitzungserneuerung verlängert die Sitzung, sie erneuert aber KEINEN Nachweis.
 */
export const FRESH_SESSION_MS = 10 * 60 * 1000;

/** Art eines Eintrags in der Geräteliste. */
export type DeviceKind = 'passkey' | 'trusted_device';

/** Ein Eintrag der Geräteliste. Passkeys und Merk-Geräte in einer Liste. */
export interface DeviceEntry {
  /** Zusammengesetzt aus Art und Datensatz-ID, z. B. `passkey:1a2b…`. */
  id: string;
  kind: DeviceKind;
  label: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  /** Merk-Geräte laufen nach 30 Tagen ab; Passkeys haben kein Ablaufdatum. */
  validUntil: Date | null;
}

/** Stand der Ersteinrichtung, damit das Frontend den Wizard steuern kann. */
export interface AccessState {
  user: SessionUser;
  passwordSet: boolean;
  passkeyCount: number;
  totpSetUp: boolean;
  /** Ist der Faktor „Code per E-Mail" eingerichtet und bestätigt? */
  emailCodeSetUp: boolean;
  /** Adresse, an die Anmeldecodes gehen. Unmaskiert — es ist die eigene. */
  loginCodeEmail: string;
  /** Alle eingerichteten zweiten Faktoren. Leer heißt: Ersteinrichtung offen. */
  setUpFactors: FactorKind[];
  openRecoveryCodes: number;
}

/** Ein Eintrag der Faktorenliste in den Einstellungen. */
export interface FactorEntry {
  kind: FactorKind;
  label: string;
  setUp: boolean;
  /** Nur bei `email-code`: die hinterlegte Zieladresse. */
  email?: string;
  /** Nur bei `passkey`: wie viele hinterlegt sind. */
  count?: number;
  /**
   * Ließe sich dieser Faktor entfernen, ohne den letzten wegzunehmen?
   * Reine Auskunft für die Oberfläche — durchgesetzt wird die Regel in
   * `pruefeNichtLetzterFaktor`, serverseitig.
   */
  removable: boolean;
}

/** Übersicht über die zweiten Faktoren. */
export interface FactorsOverview {
  factors: FactorEntry[];
  countSetUp: number;
}

/** Zerlegt eine zusammengesetzte Geräte-ID. */
function splitDeviceId(id: string): { kind: DeviceKind; recordId: string } | null {
  const separator = id.indexOf(':');
  if (separator < 1) return null;
  const kind = id.slice(0, separator);
  const recordId = id.slice(separator + 1);
  if (recordId.length === 0) return null;
  if (kind !== 'passkey' && kind !== 'trusted_device') return null;
  return { kind, recordId };
}

/**
 * Verwaltung des eigenen Zugangs: Passkeys registrieren, TOTP einrichten,
 * Wiederherstellungscodes erzeugen, Geräte auflisten und widerrufen.
 */
@Injectable()
export class AccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passkey: PasskeyService,
    private readonly totp: TotpService,
    private readonly codes: RecoveryCodeService,
    private readonly codesPerMail: EmailLoginCodeService,
    private readonly mail: MailService,
    private readonly devices: DeviceService,
    private readonly flow: LoginFlowService,
    private readonly session: SessionService,
    private readonly lockout: LockoutService,
    private readonly audit: AuditService,
  ) {}

  /** Stand der Ersteinrichtung für den angemeldeten Benutzer. */
  async state(user: SessionUser): Promise<AccessState> {
    const [passkeyCount, account, openCodes] = await Promise.all([
      this.prisma.passkeyCredential.count({ where: { userId: user.id } }),
      this.prisma.user.findUnique({
        where: { id: user.id },
        select: {
          email: true,
          passwordHash: true,
          totpSecret: true,
          loginCodeEmail: true,
          loginCodeEnabled: true,
        },
      }),
      this.codes.countOpen(user.id),
    ]);
    if (!account) {
      throw new NotFoundException('Konto nicht gefunden.');
    }
    const base: FactorBase = {
      loginCodeEnabled: account.loginCodeEnabled,
      totpSecret: account.totpSecret,
      passkeyCount,
    };
    // Nur ob etwas hinterlegt ist — der Hash verlässt den Service nie.
    return {
      user,
      passwordSet: account.passwordHash !== null,
      passkeyCount,
      totpSetUp: account.totpSecret !== null,
      emailCodeSetUp: account.loginCodeEnabled,
      loginCodeEmail: this.codesPerMail.targetAddress(account),
      setUpFactors: setUpFactors(base),
      openRecoveryCodes: openCodes,
    };
  }

  // -------------------------------------------------------------------------
  // Zweite Faktoren: auflisten, hinzufügen, entfernen
  // -------------------------------------------------------------------------

  /** Lädt, was für jede Faktor-Aussage gebraucht wird. */
  private async factorBase(
    userId: string,
  ): Promise<FactorBase & { email: string; loginCodeEmail: string | null }> {
    const [account, passkeyCount] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          email: true,
          totpSecret: true,
          loginCodeEmail: true,
          loginCodeEnabled: true,
        },
      }),
      this.prisma.passkeyCredential.count({ where: { userId } }),
    ]);
    if (!account) {
      throw new NotFoundException('Konto nicht gefunden.');
    }
    return { ...account, passkeyCount };
  }

  /** Die drei Faktorarten mit ihrem Zustand, für die Einstellungsseite. */
  async factors(userId: string): Promise<FactorsOverview> {
    const base = await this.factorBase(userId);
    const kinds: FactorKind[] = ['email-code', 'totp', 'passkey'];
    const factors = kinds.map<FactorEntry>((kind) => {
      const setUp = isSetUp(base, kind);
      return {
        kind,
        label: FACTOR_LABEL[kind],
        setUp,
        ...(kind === 'email-code'
          ? { email: this.codesPerMail.targetAddress(base) }
          : {}),
        ...(kind === 'passkey' ? { count: base.passkeyCount } : {}),
        removable: setUp && factorsAfterRemoval(base, kind) >= 1,
      };
    });
    return {
      factors,
      countSetUp: setUpFactors(base).length,
    };
  }

  /**
   * Entfernt einen Faktor — ABER NUR, wenn danach mindestens einer übrig
   * bleibt. Prüfung und Entfernung stecken in EINER Transaktion, die zuerst
   * die Benutzerzeile sperrt.
   *
   * DAS WAR DER BEFUND [K1]: vorher las `faktorGrundlage()` den Stand und die
   * Entfernung schrieb danach — dazwischen lag nichts. Zwei gleichzeitige
   * Löschanfragen auf die letzten ZWEI Faktoren sahen beide „einer bleibt ja
   * übrig" und gingen beide durch; das Konto stand danach ohne jeden zweiten
   * Faktor da. Genau die Aussperrung, die diese Regel verhindern soll.
   *
   * Warum ein Zeilen-Lock und nicht ein bedingtes UPDATE wie sonst im Projekt:
   * Die Invariante spannt über ZWEI Tabellen (`Benutzer.totpGeheimnis`,
   * `Benutzer.anmeldecodeAktiv`, Zeilen in `PasskeyAnmeldedaten`). Ein
   * bedingtes UPDATE kann nur seine eigene Zeile bedingen — die
   * Kreuzkombination „TOTP ∥ Passkey" bliebe offen. `SELECT … FOR UPDATE` auf
   * die Benutzerzeile ist der gemeinsame Engpass ALLER drei Löschpfade:
   * Postgres serialisiert sie, der zweite Aufruf liest anschließend den
   * bereits verringerten Stand und wird abgewiesen.
   *
   * `passkeyId` ist nur beim Widerruf eines Passkeys gesetzt.
   */
  private async removeFactorAtomic(
    userId: string,
    kind: FactorKind,
    passkeyId: string | null,
  ): Promise<'removed' | 'last_factor' | 'not_set_up'> {
    return this.prisma.$transaction(async (tx) => {
      // Der Engpass. Ab hier wartet jede weitere Faktoränderung dieses Kontos,
      // bis diese Transaktion fertig ist.
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;

      const account = await tx.user.findUnique({
        where: { id: userId },
        select: { totpSecret: true, loginCodeEnabled: true },
      });
      if (!account) {
        throw new NotFoundException('Konto nicht gefunden.');
      }
      const passkeyCount = await tx.passkeyCredential.count({
        where: { userId },
      });
      const base: FactorBase = { ...account, passkeyCount };

      if (!isSetUp(base, kind)) return 'not_set_up';
      if (factorsAfterRemoval(base, kind) < 1) return 'last_factor';

      if (kind === 'totp') {
        await tx.user.update({
          where: { id: userId },
          data: {
            totpSecret: null,
            totpSecretPending: null,
            totpPendingValidUntil: null,
          },
        });
      } else if (kind === 'email-code') {
        await tx.user.update({
          where: { id: userId },
          data: { loginCodeEnabled: false, loginCodeEmail: null },
        });
        // Ein noch offener Code darf einen abgeschalteten Faktor nicht überleben.
        await tx.emailLoginCode.deleteMany({ where: { userId } });
      } else {
        if (!passkeyId) {
          throw new NotFoundException('Diesen Passkey gibt es nicht.');
        }
        // Bedingt auf `benutzerId`: ein fremder Passkey wird hier nie gelöscht,
        // auch wenn die ID stimmen sollte.
        const deleted = await tx.passkeyCredential.deleteMany({
          where: { id: passkeyId, userId },
        });
        if (deleted.count !== 1) return 'not_set_up';
      }
      return 'removed';
    });
  }

  /** Protokolliert eine abgewiesene Entfernung und wirft. */
  private async rejectLastFactor(
    userId: string,
    kind: FactorKind,
    source: InquirySource,
    actor: string,
  ): Promise<never> {
    await this.audit.log({
      userId,
      actor,
      action: AUDIT_ACTION.factorRemoveRejected,
      objectType: 'User',
      objectId: userId,
      afterValue: {
        factor: kind,
        reason: 'Es wäre der letzte eingerichtete zweite Faktor gewesen.',
      },
      ip: source.ip,
      userAgent: source.userAgent,
    });
    throw new LastFactorError(FACTOR_LABEL[kind]);
  }

  /**
   * Schickt einen achtstelligen Bestätigungscode an die gewünschte Adresse.
   *
   * Die Adresse wird NOCH NICHT übernommen — sie steht bis zur Bestätigung nur
   * auf dem Code-Datensatz. Ein Tippfehler kann so einen bereits aktiven Faktor
   * nicht auf eine unerreichbare Adresse umbiegen.
   *
   * Der Nachweis eines zweiten Faktors wird verlangt — seit [K4] nicht mehr
   * hier, sondern deklarativ vom `ZweitfaktorGuard` an der Route. Das war der
   * Befund [W3]: die Bestätigung beweist nur
   * die Kontrolle über die NEUE Adresse, nicht das Recht zur Änderung. Wer ein
   * Sitzungs-Cookie erbeutet, konnte sonst die Zustelladresse des zweiten
   * Faktors auf sich umbiegen, bestätigen, den anderen Faktor entfernen — und
   * bekam den zweiten Faktor der Betreiberin dauerhaft zugestellt. Nebenbei
   * war es ein Ausgangskanal für Mail an beliebige Adressen unter der
   * SPF/DKIM-Kennung der Betreiberin.
   *
   * ZUSÄTZLICH geht eine Hinweismail an die BISHERIGE Adresse, sobald sich die
   * Zustelladresse eines bereits aktiven Faktors ändern soll. Nur wenn sie sich
   * wirklich ändert: geht der Code an dieselbe Adresse wie bisher, gibt es
   * nichts zu warnen — die Warnung läge im selben Postfach wie der Code.
   */
  async emailCodeSetup(
    user: SessionUser,
    requestedEmail: string | undefined,
    source: InquirySource,
  ): Promise<{ email: string; secondsValid: number }> {
    const account = await this.factorBase(user.id);
    const previous = this.codesPerMail.targetAddress(account);
    const target = (requestedEmail ?? previous).trim().toLowerCase();
    const isChange = account.loginCodeEnabled && target !== previous;

    const result = await this.codesPerMail.request(user.id, target, true);
    if (result.kind === 'too_early') {
      // Aus einer Sitzung heraus gibt es kein Kennungs-Leck zu schützen —
      // hier ist die klare Ansage samt Restzeit das Richtige.
      throw new BusinessError(
        'login_code_too_early',
        'Es wurde gerade erst ein Code verschickt. Bitte kurz warten.',
        HttpStatus.TOO_MANY_REQUESTS,
        { secondsRemaining: result.secondsRemaining },
      );
    }

    try {
      await this.mail.sendLoginCode(
        target,
        result.code,
        CODE_VALID_MS / 60_000,
        true,
      );
    } catch (error) {
      // Nur diese eine Zeile, nicht „der Code des Kontos" ([W2]).
      await this.codesPerMail.discard(result.codeId, result.createdAt);
      throw error;
    }

    if (isChange) {
      // Die Warnung darf den Vorgang NICHT scheitern lassen: der Code ist
      // schon unterwegs, und ein toter Altpostfach-Server wäre sonst eine
      // Sackgasse. Sie wird protokolliert, damit der Fehlschlag nachweisbar ist.
      try {
        await this.mail.sendAddressChangeNote(previous, target);
      } catch {
        await this.audit.log({
          userId: user.id,
          actor: user.username,
          action: AUDIT_ACTION.emailCodeNotSent,
          objectType: 'User',
          objectId: user.id,
          afterValue: {
            reason: 'Hinweis auf den Adresswechsel konnte nicht zugestellt werden.',
            recipient: previous,
          },
          ip: source.ip,
          userAgent: source.userAgent,
        });
      }
      await this.audit.log({
        userId: user.id,
        actor: user.username,
        action: AUDIT_ACTION.emailCodeAddressChangeRequested,
        objectType: 'User',
        objectId: user.id,
        beforeValue: { recipient: previous },
        afterValue: { recipient: target, confirmed: false },
        ip: source.ip,
        userAgent: source.userAgent,
      });
    }

    return { email: target, secondsValid: CODE_VALID_MS / 1000 };
  }

  /**
   * Bestätigt den Einrichtungscode: erst jetzt gilt der Faktor als eingerichtet
   * und erst jetzt wird die Zieladresse übernommen.
   *
   * Ein Fehlversuch zählt hier BEWUSST NICHT auf die Kontosperre. Anders als
   * bei der Anmeldung sitzt hier jemand mit gültiger Sitzung; ihn wegen ein
   * paar Vertippern beim Einrichten für 15 Minuten auszusperren wäre Schaden
   * ohne Nutzen. Gegen das Raten schützt der Code selbst: nach
   * `CODE_MAX_FEHLVERSUCHE` Fehleingaben ist er verbrannt, dazu kommt das
   * Rate-Limit der Route.
   */
  async emailCodeConfirm(
    user: SessionUser,
    code: string,
    source: InquirySource,
  ): Promise<{ email: string }> {
    const result = await this.codesPerMail.resolve(user.id, code, true);
    if (result.kind !== 'ok') {
      // Der Grund geht als `detail` mit, damit die Oberfläche „falsch",
      // „verbrannt" und „abgelaufen" auseinanderhalten kann ([DW1]). Hier
      // sitzt jemand mit gültiger Sitzung — es wird nichts verraten, was er
      // nicht schon wüsste. `fehlversuche` bleibt bewusst draußen.
      const reason = reasonOf(result);
      throw new LoginFailedError(
        reason ? MESSAGE_TO_REASON[reason] : MESSAGE_WITHOUT_REASON,
        reason ? { reason } : undefined,
      );
    }

    const before = await this.factorBase(user.id);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        loginCodeEmail: result.targetEmail,
        loginCodeEnabled: true,
      },
    });
    await this.audit.log({
      userId: user.id,
      actor: user.username,
      action: AUDIT_ACTION.emailCodeSetUp,
      objectType: 'User',
      objectId: user.id,
      beforeValue: {
        active: before.loginCodeEnabled,
        recipient: this.codesPerMail.targetAddress(before),
      },
      afterValue: { active: true, recipient: result.targetEmail },
      ip: source.ip,
      userAgent: source.userAgent,
    });
    return { email: result.targetEmail };
  }

  /**
   * Entfernt einen zweiten Faktor (TOTP oder E-Mail-Code).
   *
   * Passkeys werden nicht hierüber entfernt, sondern einzeln über die
   * Geräteliste (`widerrufe`) — dort greift dieselbe Sperre gegen den letzten
   * Faktor.
   *
   * Alle Merk-Geräte werden entwertet: wer seine Anmeldemittel VERKLEINERT,
   * soll keine Geräte im Umlauf lassen, die den zweiten Faktor überspringen.
   * Beim HINZUFÜGEN passiert das bewusst nicht — dort wird nichts schwächer.
   */
  async factorRemove(
    user: SessionUser,
    kind: 'totp' | 'email-code',
    source: InquirySource,
  ): Promise<{ invalidatedTrustedDevices: number }> {
    // Der Nachweis eines zweiten Faktors ist Pflicht ([W4]) und wird vom
    // `ZweitfaktorGuard` an der Route erbracht, nicht hier.
    const result = await this.removeFactorAtomic(user.id, kind, null);
    if (result === 'not_set_up') {
      throw new NotFoundException(
        `Der Faktor „${FACTOR_LABEL[kind]}" ist nicht eingerichtet.`,
      );
    }
    if (result === 'last_factor') {
      await this.rejectLastFactor(
        user.id,
        kind,
        source,
        user.username,
      );
    }

    const invalidated = await this.devices.revokeAll(user.id);
    await this.audit.log({
      userId: user.id,
      actor: user.username,
      action:
        kind === 'totp'
          ? AUDIT_ACTION.totpRemoved
          : AUDIT_ACTION.emailCodeRemoved,
      objectType: 'User',
      objectId: user.id,
      beforeValue: { factor: kind, setUp: true },
      afterValue: {
        factor: kind,
        setUp: false,
        invalidatedTrustedDevices: invalidated,
      },
      ip: source.ip,
      userAgent: source.userAgent,
    });
    return { invalidatedTrustedDevices: invalidated };
  }

  // -------------------------------------------------------------------------
  // Zweiter Faktor für heikle Aktionen
  // -------------------------------------------------------------------------

  /**
   * Verlangt vor einer heiklen Aktion einen zweiten Faktor: das aktuelle
   * Passwort ODER einen TOTP-Code. Die Sitzung allein genügt nicht.
   *
   * Grund: Wer ein Sitzungs-Cookie erbeutet, könnte sonst einen eigenen Passkey
   * registrieren und hätte damit einen einstufigen Dauerzugang, der Passwort
   * und TOTP zugleich ersetzt.
   *
   * Fehlversuche zählen auf die Kontosperre — es sind geratene Geheimnisse.
   */
  async checkSecondFactor(
    userId: string,
    evidence: { currentPassword?: string; totpCode?: string },
    source: InquirySource,
    /**
     * Ausstellungszeitpunkt der Sitzung aus dem SIGNIERTEN Token. Ist er
     * jünger als FRISCHE_SITZUNG_MS, entfällt der Nachweis. `null` (Token ohne
     * Zeitpunkt) gilt als nicht frisch.
     */
    sessionEvidenceAt: Date | null = null,
    now: Date = new Date(),
  ): Promise<void> {
    // Frische Sitzung: der Nachweis wurde vor höchstens 10 Minuten erbracht.
    // Das deckt die Ersteinrichtung ab, in der Passwort und TOTP unmittelbar
    // zuvor gesetzt wurden — dort erneut zu fragen wäre reine Reibung.
    if (sessionEvidenceAt) {
      const age = now.getTime() - sessionEvidenceAt.getTime();
      if (age >= 0 && age < FRESH_SESSION_MS) {
        return;
      }
    }

    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        passwordHash: true,
        totpSecret: true,
        failedAttempts: true,
        lockedUntil: true,
      },
    });
    if (!account) {
      throw new NotFoundException('Konto nicht gefunden.');
    }
    this.lockout.checkNotLocked(account);

    const { currentPassword, totpCode } = evidence;
    let confirmed = false;

    if (currentPassword && account.passwordHash) {
      try {
        confirmed = await argon2.verify(account.passwordHash, currentPassword);
      } catch {
        confirmed = false;
      }
    } else if (totpCode) {
      confirmed = await this.totp.checkAndConsume(
        account.id,
        account.totpSecret,
        totpCode,
      );
    } else {
      // Gar kein Nachweis mitgeschickt: kein Fehlversuch, nur eine klare Ansage.
      throw new LoginFailedError(
        'Für diese Aktion ist das aktuelle Passwort oder ein Bestätigungscode nötig.',
      );
    }

    if (confirmed) {
      // Erfolgreicher Nachweis setzt den Sperrzähler zurück — genauso wie eine
      // erfolgreiche Anmeldung (`stelleSitzungAus`) und ein Passwortwechsel
      // (`setzePasswort`). Ohne das hinge das Ergebnis davon ab, WO das
      // Geheimnis bewiesen wurde: vier Fehlversuche bei der Anmeldung plus ein
      // erfolgreicher Nachweis hier hätten den Zähler auf vier stehen lassen,
      // und der nächste Vertipper hätte gesperrt — ohne erkennbaren Zusammenhang.
      await this.lockout.setBack(account.id);
      return;
    }

    const lockoutSeconds = await this.lockout.recordFailedAttempt(account, source);
    await this.audit.log({
      userId: account.id,
      actor: account.username,
      action: AUDIT_ACTION.secondFactorError,
      objectType: 'User',
      objectId: account.id,
      afterValue: {
        reason: currentPassword
          ? 'Aktuelles Passwort falsch.'
          : 'Bestätigungscode falsch.',
      },
      ip: source.ip,
      userAgent: source.userAgent,
    });
    if (lockoutSeconds > 0) {
      throw new AccountLockedError(lockoutSeconds);
    }
    throw new LoginFailedError(
      'Der Nachweis war nicht gültig. Bitte erneut versuchen.',
    );
  }

  // -------------------------------------------------------------------------
  // Passkey-Registrierung
  // -------------------------------------------------------------------------

  /** Startet die Registrierung eines Passkeys für ein bekanntes Konto. */
  private async registrationStartFor(user: {
    id: string;
    email: string;
    name: string;
  }): Promise<{
    options: PublicKeyCredentialCreationOptionsJSON;
    flowToken: string;
  }> {
    const options = await this.passkey.registrationOptions(user);
    return {
      options,
      flowToken: await this.flow.create({
        type: 'passkey-registration',
        userId: user.id,
        challenge: options.challenge,
      }),
    };
  }

  /** Startet die Registrierung für den angemeldeten Benutzer. */
  async registrationStart(user: SessionUser): Promise<{
    options: PublicKeyCredentialCreationOptionsJSON;
    flowToken: string;
  }> {
    return this.registrationStartFor(user);
  }

  /** Startet die Registrierung für einen per Notfall-Token bestätigten Benutzer. */
  async registrationStartEmergency(user: {
    id: string;
    email: string;
    name: string;
  }): Promise<{
    options: PublicKeyCredentialCreationOptionsJSON;
    flowToken: string;
  }> {
    return this.registrationStartFor(user);
  }

  /**
   * Schließt die Registrierung ab und speichert den Passkey.
   *
   * Jede Änderung an den Passkeys entwertet ZWANGSWEISE alle Merk-Geräte:
   * wer die Anmeldemittel ändert, soll nicht weiterhin Geräte im Umlauf haben,
   * die den zweiten Faktor überspringen.
   */
  async registrationComplete(
    userId: string,
    flowToken: string | undefined,
    response: RegistrationResponseJSON,
    labelRequested: string | undefined,
    source: InquirySource,
  ): Promise<{ passkeyId: string; label: string; sessionToken: string }> {
    const flow = await this.flow.read(flowToken, 'passkey-registration');
    if (flow.userId !== userId || !flow.challenge) {
      throw new LoginFailedError(
        'Der Registriervorgang gehört nicht zu diesem Konto.',
      );
    }

    const verified = await this.passkey.checkRegistration(
      response,
      flow.challenge,
    );
    if (!verified) {
      throw new LoginFailedError(
        'Der Passkey konnte nicht bestätigt werden.',
      );
    }

    const label =
      labelRequested?.trim() ||
      labelFromUserAgent('Passkey', source.userAgent);
    const passkeyId = await this.passkey.store(userId, label, verified);
    const invalidated = await this.devices.revokeAll(userId);
    // Ein neuer Passkey ist ein neuer Vollzugang: alle bisherigen Sitzungen
    // enden. Das eigene Token wird unten frisch ausgestellt.
    await this.session.invalidateAllSessions(userId);

    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    await this.audit.log({
      userId,
      actor: account?.email ?? userId,
      action: AUDIT_ACTION.passkeyRegistered,
      objectType: 'PasskeyCredential',
      objectId: passkeyId,
      afterValue: { label, invalidatedTrustedDevices: invalidated },
      ip: source.ip,
      userAgent: source.userAgent,
    });

    return {
      passkeyId,
      label,
      sessionToken: await this.session.createToken(userId),
    };
  }

  // -------------------------------------------------------------------------
  // Passwort
  // -------------------------------------------------------------------------

  /**
   * Setzt oder ändert das eigene Passwort aus einer bestehenden Sitzung heraus.
   *
   * Ist am Konto noch KEIN Passwort hinterlegt (Ersteinrichtung), darf
   * `aktuellesPasswort` fehlen — die Sitzung ist dann der Nachweis. Sobald eines
   * gesetzt ist, wird es verlangt und geprüft; ein falscher Versuch zahlt auf
   * denselben Sperrzähler ein wie eine fehlgeschlagene Anmeldung, denn es ist
   * derselbe Angriff auf dasselbe Geheimnis.
   *
   * BENANNTE AUSNAHME ([H6]): In genau diesem Fall — `passwortHash === null` —
   * verlangt die Route KEINEN Nachweis und stellt danach ein Token mit frischem
   * `auth_time` aus. Für die Ersteinrichtung ist das richtig, sonst käme
   * niemand über den ersten Schritt hinaus. ABER nur aus einer Sitzung, deren
   * Anmeldung höchstens FRISCHE_SITZUNG_MS zurückliegt ([H2], Prüfung vom
   * 13.09.2026). Der Zustand „kein Passwort" hält an, bis der Wizard Schritt 1
   * abschliesst; solche Konten entstehen über `first-account` und
   * `emergency enrollment`. Vorher genügte hier JEDES gültige Sitzungs-Cookie:
   * Wer ein tagealtes erbeutet hatte, setzte ein eigenes Passwort, bekam dafür
   * ein frisches `auth_time` und damit zehn Minuten Nachweisfreiheit für
   * Passkey, Faktoren und neue Konten. Wer im Wizard zu lange wartet, meldet
   * sich mit seinem Passkey neu an — das ist ein echter Nachweis.
   *
   * Alle Merk-Geräte werden entwertet: eine Passwortänderung darf keinen
   * 30-Tage-Überspringer für den zweiten Faktor stehen lassen.
   *
   * GIBT EIN NEUES SITZUNGSTOKEN ZURÜCK. `entwerteAlleSitzungen` trifft auch
   * die Sitzung, aus der heraus gerade gehandelt wird — ohne Ersatz landete der
   * Benutzer unmittelbar nach `200` auf einem 401 und damit auf einem
   * Sackgassen-Bildschirm. In der Ersteinrichtung war das fatal: Schritt 1
   * beendete den Wizard, Schritt 2 (Wahl des zweiten Faktors) und Schritt 4
   * (Wiederherstellungscodes) fielen aus, und das Konto stand mit einem Faktor
   * und null Wiederherstellungscodes da ([K3]).
   *
   * Das Vorbild ist `registrierungAbschluss` weiter oben in dieser Datei: erst
   * entwerten, dann ein frisches Token ausstellen, das der Controller als
   * Cookie setzt.
   *
   * Das neue Token trägt einen FRISCHEN Nachweiszeitpunkt — zu Recht: wer
   * gerade sein Passwort bewiesen (oder bei der Ersteinrichtung erstmals
   * gesetzt) hat, hat sich soeben ausgewiesen.
   */
  async setPassword(
    user: SessionUser,
    newPassword: string,
    currentPassword: string | undefined,
    source: InquirySource,
    /**
     * Nachweiszeitpunkt der Sitzung (`auth_time` aus dem SIGNIERTEN Token).
     * Zählt nur, solange noch KEIN Passwort gesetzt ist. `null` gilt als nicht
     * frisch — dieselbe Regel wie in `pruefeZweitenFaktor`.
     */
    sessionEvidenceAt: Date | null = null,
    now: Date = new Date(),
  ): Promise<{ sessionToken: string }> {
    const account = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        username: true,
        email: true,
        passwordHash: true,
        failedAttempts: true,
        lockedUntil: true,
      },
    });
    if (!account) {
      throw new NotFoundException('Konto nicht gefunden.');
    }

    const previousHash = account.passwordHash;
    const wasAlreadySet = previousHash !== null;

    if (previousHash === null) {
      // [H2]: Ohne bisheriges Passwort ist die Anmeldung selbst der Nachweis —
      // aber nur, wenn sie frisch ist. NaN (kein Zeitpunkt) und ein Zeitpunkt
      // in der Zukunft fallen beide durch.
      const age = sessionEvidenceAt
        ? now.getTime() - sessionEvidenceAt.getTime()
        : Number.NaN;
      if (!(age >= 0 && age < FRESH_SESSION_MS)) {
        await this.audit.log({
          userId: account.id,
          actor: account.username,
          action: AUDIT_ACTION.passwordChangeError,
          objectType: 'User',
          objectId: account.id,
          afterValue: {
            reason: 'Erstvergabe aus einer Sitzung, deren Anmeldung zu lange zurückliegt.',
          },
          ip: source.ip,
          userAgent: source.userAgent,
        });
        throw new BusinessError(
          'login_too_old',
          'Deine Anmeldung liegt zu lange zurück, um ohne bisheriges Passwort ein neues zu setzen. '
            + 'Bitte melde dich ab und mit deinem Passkey neu an — danach hast du zehn Minuten Zeit.',
          HttpStatus.FORBIDDEN,
        );
      }
    }

    if (previousHash !== null) {
      // Gesperrtes Konto: auch aus einer gültigen Sitzung heraus kein Rateweg
      // auf das aktuelle Passwort.
      this.lockout.checkNotLocked(account);

      if (currentPassword === undefined || currentPassword.length === 0) {
        throw new LoginFailedError(
          'Zum Ändern des Passworts ist das aktuelle Passwort nötig.',
        );
      }

      let matches = false;
      try {
        matches = await argon2.verify(previousHash, currentPassword);
      } catch {
        matches = false;
      }
      if (!matches) {
        const lockoutSeconds = await this.lockout.recordFailedAttempt(
          account,
          source,
        );
        await this.audit.log({
          userId: account.id,
          actor: account.username,
          action: AUDIT_ACTION.passwordChangeError,
          objectType: 'User',
          objectId: account.id,
          afterValue: { reason: 'Aktuelles Passwort falsch.' },
          ip: source.ip,
          userAgent: source.userAgent,
        });
        if (lockoutSeconds > 0) {
          throw new AccountLockedError(lockoutSeconds);
        }
        throw new LoginFailedError(
          'Das aktuelle Passwort ist falsch.',
        );
      }
    }

    const passwordHash = await argon2.hash(newPassword, {
      type: argon2.argon2id,
    });
    await this.prisma.user.update({
      where: { id: account.id },
      data: {
        passwordHash,
        failedAttempts: 0,
        lockedUntil: null,
        // Ein angefangener TOTP-Einrichtungsdialog überlebt den Passwortwechsel
        // NICHT ([K5]). Wer sein Passwort wechselt, weil er einen Fremdzugriff
        // vermutet, würde sonst genau die Ratestrecke stehen lassen, über die
        // sich der Angreifer einen eigenen zweiten Faktor verschafft.
        totpSecretPending: null,
        totpPendingValidUntil: null,
      },
    });
    const invalidated = await this.devices.revokeAll(account.id);
    // Alle laufenden Sitzungen enden — auch ein gestohlenes Cookie.
    await this.session.invalidateAllSessions(account.id);

    // Im Audit-Log steht NUR die Tatsache der Änderung — niemals das Passwort
    // und niemals ein Hash, weder das alte noch das neue.
    await this.audit.log({
      userId: account.id,
      actor: account.username,
      action: AUDIT_ACTION.passwordSet,
      objectType: 'User',
      objectId: account.id,
      beforeValue: { updated: false, wasAlreadySet },
      afterValue: {
        updated: true,
        viaEmergencyLink: false,
        invalidatedTrustedDevices: invalidated,
      },
      ip: source.ip,
      userAgent: source.userAgent,
    });

    // Ersatz für die soeben mitentwertete eigene Sitzung.
    return { sessionToken: await this.session.createToken(account.id) };
  }

  // -------------------------------------------------------------------------
  // TOTP und Wiederherstellungscodes
  // -------------------------------------------------------------------------

  /**
   * Erzeugt ein neues TOTP-Geheimnis. Klartext und otpauth-URL werden EINMAL
   * zurückgegeben und danach nur noch verschlüsselt vorgehalten.
   */
  async totpSetup(user: SessionUser): Promise<TotpSetup> {
    return this.totp.setUp(user.id, user.email);
  }

  /**
   * Bestätigt die TOTP-Einrichtung mit einem Code aus der App.
   * Erst danach gilt der TOTP-Weg als eingerichtet.
   *
   * DIESE ROUTE IST EINE RATESTRECKE AUF EINEN ZWEITEN FAKTOR ([K5]).
   *
   * Sie trägt `@OhneZweitfaktor`, weil der erste Schritt (`totp/einrichten`)
   * den Nachweis bereits verlangt hat. Das stimmt — aber wer ein vorläufiges
   * Geheimnis am Konto hat, ratet hier auf sechs Ziffern, und ein Treffer
   * macht das geratene Geheimnis SOFORT zum aktiven `totpGeheimnis`. Ab da ist
   * `totpCode` ein gültiger Nachweis für jede geschützte Route.
   *
   * Deshalb ist der Fehlschlag hier genauso teuer wie ein falscher Code bei
   * der Anmeldung: er zählt über `SperreService.verbucheFehlversuch` auf die
   * Kontosperre und schreibt eine Zeile ins Audit-Log. Dazu kommen das
   * `@Throttle` an der Route und die Frist auf dem vorläufigen Geheimnis.
   *
   * NUR der falsche Code zählt. „Kein Geheimnis hinterlegt" und „abgelaufen"
   * sind Zustandsfehler, keine Rateversuche — sie würden den Zähler sonst
   * hochtreiben, ohne dass jemand etwas geraten hätte.
   */
  async totpConfirm(
    user: SessionUser,
    code: string,
    source: InquirySource,
  ): Promise<void> {
    const account = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        username: true,
        email: true,
        failedAttempts: true,
        lockedUntil: true,
      },
    });
    if (!account) {
      throw new NotFoundException('Konto nicht gefunden.');
    }
    // Ein gesperrtes Konto ist auch aus einer gültigen Sitzung heraus kein
    // Rateweg — dieselbe Schranke wie in `setzePasswort`.
    this.lockout.checkNotLocked(account);

    // Erst HIER wird das vorläufige Geheimnis zum aktiven. Ein abgebrochener
    // Einrichtungsdialog lässt den bestehenden Authenticator unberührt.
    const result = await this.totp.confirm(user.id, code);

    if (result === 'no_secret') {
      throw new NotFoundException(
        'Es ist kein TOTP-Geheimnis hinterlegt. Bitte die Einrichtung erneut starten.',
      );
    }
    if (result === 'expired') {
      throw new NotFoundException(
        'Die Einrichtung ist abgelaufen. Bitte die Einrichtung erneut starten.',
      );
    }
    if (result === 'wrong') {
      const lockoutSeconds = await this.lockout.recordFailedAttempt(
        account,
        source,
      );
      await this.audit.log({
        userId: account.id,
        actor: account.username,
        action: AUDIT_ACTION.totpSetupError,
        objectType: 'User',
        objectId: account.id,
        // NIEMALS der geratene Code und niemals das Geheimnis — nur die
        // Tatsache des Fehlschlags.
        afterValue: { reason: 'Bestätigungscode der Einrichtung falsch.' },
        ip: source.ip,
        userAgent: source.userAgent,
      });
      if (lockoutSeconds > 0) {
        throw new AccountLockedError(lockoutSeconds);
      }
      throw new LoginFailedError(
        'Falscher Code. Bitte erneut versuchen.',
      );
    }

    // Erfolgreicher Nachweis setzt den Sperrzähler zurück — dieselbe Regel wie
    // in `pruefeZweitenFaktor` und `stelleSitzungAus`. Hierher kommt nur, wer
    // den Nachweis auf `totp/einrichten` schon erbracht hat; ohne das Zurück-
    // setzen könnten vier Vertipper beim Einrichten den nächsten Vertipper bei
    // der Anmeldung zur Sperre machen, ohne erkennbaren Zusammenhang.
    await this.lockout.setBack(account.id);
    await this.audit.log({
      userId: user.id,
      actor: user.email,
      action: AUDIT_ACTION.totpSetUp,
      objectType: 'User',
      objectId: user.id,
      afterValue: { totpSetUp: true },
      ip: source.ip,
      userAgent: source.userAgent,
    });
  }

  /** Erzeugt acht neue Wiederherstellungscodes und verwirft alle alten. */
  async recoveryCodesNew(
    user: SessionUser,
    source: InquirySource,
  ): Promise<string[]> {
    const codes = await this.codes.generateNewCodes(user.id);
    await this.audit.log({
      userId: user.id,
      actor: user.email,
      action: AUDIT_ACTION.recoveryCodesNew,
      objectType: 'RecoveryCode',
      objectId: user.id,
      afterValue: { count: codes.length },
      ip: source.ip,
      userAgent: source.userAgent,
    });
    return codes;
  }

  // -------------------------------------------------------------------------
  // Geräteliste
  // -------------------------------------------------------------------------

  /** Passkeys und Merk-Geräte als eine Liste, neueste zuerst. */
  async deviceList(userId: string): Promise<DeviceEntry[]> {
    const [passkeys, trustedDevices] = await Promise.all([
      this.prisma.passkeyCredential.findMany({
        where: { userId },
        select: {
          id: true,
          label: true,
          createdAt: true,
          lastUsedAt: true,
        },
      }),
      this.devices.list(userId),
    ]);

    const entries: DeviceEntry[] = [
      ...passkeys.map((passkey) => ({
        id: `passkey:${passkey.id}`,
        kind: 'passkey' as const,
        label: passkey.label,
        createdAt: passkey.createdAt,
        lastSeenAt: passkey.lastUsedAt,
        validUntil: null,
      })),
      ...trustedDevices.map((device) => ({
        id: `trusted_device:${device.id}`,
        kind: 'trusted_device' as const,
        label: device.label,
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt,
        validUntil: device.validUntil,
      })),
    ];
    return entries.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  /**
   * Widerruft einen Eintrag der Geräteliste.
   *
   * Beim Widerruf eines Passkeys werden zusätzlich ALLE Merk-Geräte entwertet
   * (Passkey-Änderung). Der letzte Passkey lässt sich nicht widerrufen, solange
   * er der einzige zweite Faktor ist — sonst sperrt sich der Benutzer selbst
   * aus. Durchgesetzt wird das von `pruefeNichtLetzterFaktor`, serverseitig und
   * mit demselben Fehlercode wie beim Entfernen von TOTP oder E-Mail-Code.
   */
  async revoke(
    user: SessionUser,
    compositeId: string,
    evidence: { currentPassword?: string; totpCode?: string },
    source: InquirySource,
    sessionEvidenceAt: Date | null = null,
  ): Promise<{ label: string; kind: DeviceKind }> {
    // EINZIGE Stelle, an der die Nachweispflicht noch im Service steht: die
    // Route bedient ZWEI Fälle mit unterschiedlichem Gewicht. Ein Merk-Gerät zu
    // widerrufen macht die Anmeldung strenger und ist deshalb frei; einen
    // Passkey zu widerrufen entfernt einen FAKTOR. Ein Guard an der Route kann
    // das nicht auseinanderhalten, ohne den Pfadparameter zu deuten — deshalb
    // trägt die Route `@OhneZweitfaktor(…)` mit genau dieser Begründung, und
    // die Unterscheidung steht hier.
    const split = splitDeviceId(compositeId);
    if (!split) {
      throw new NotFoundException('Unbekannter Eintrag in der Geräteliste.');
    }

    // Nur der Passkey-Zweig entfernt einen FAKTOR und verlangt deshalb den
    // Nachweis ([W4]). Ein Merk-Gerät zu widerrufen nimmt niemandem etwas weg,
    // es entzieht nur eine Abkürzung — dafür wäre die Hürde reine Reibung.
    if (split.kind === 'passkey') {
      await this.checkSecondFactor(
        user.id,
        evidence,
        source,
        sessionEvidenceAt,
      );
    }

    if (split.kind === 'trusted_device') {
      const label = await this.devices.revoke(
        user.id,
        split.recordId,
      );
      if (!label) {
        throw new NotFoundException('Dieses Gerät gibt es nicht.');
      }
      await this.audit.log({
        userId: user.id,
        actor: user.email,
        action: AUDIT_ACTION.deviceRevoked,
        objectType: 'Device',
        objectId: split.recordId,
        beforeValue: { label, active: true },
        afterValue: { active: false },
        ip: source.ip,
        userAgent: source.userAgent,
      });
      return { label, kind: 'trusted_device' };
    }

    const passkey = await this.prisma.passkeyCredential.findUnique({
      where: { id: split.recordId },
      select: { id: true, userId: true, label: true },
    });
    if (!passkey || passkey.userId !== user.id) {
      throw new NotFoundException('Diesen Passkey gibt es nicht.');
    }

    // DERSELBE Engpass wie beim Entfernen von TOTP oder E-Mail-Code. Ohne das
    // bliebe die Kreuzkombination aus [K1] offen: „letzten Passkey löschen"
    // parallel zu „E-Mail-Code entfernen" ging in 5 von 6 Läufen durch.
    const result = await this.removeFactorAtomic(
      user.id,
      'passkey',
      passkey.id,
    );
    if (result === 'not_set_up') {
      throw new NotFoundException('Diesen Passkey gibt es nicht.');
    }
    if (result === 'last_factor') {
      await this.rejectLastFactor(
        user.id,
        'passkey',
        source,
        user.username,
      );
    }

    const invalidated = await this.devices.revokeAll(user.id);
    await this.session.invalidateAllSessions(user.id);
    await this.audit.log({
      userId: user.id,
      actor: user.email,
      action: AUDIT_ACTION.passkeyRevoked,
      objectType: 'PasskeyCredential',
      objectId: passkey.id,
      beforeValue: { label: passkey.label, active: true },
      afterValue: { active: false, invalidatedTrustedDevices: invalidated },
      ip: source.ip,
      userAgent: source.userAgent,
    });
    return { label: passkey.label, kind: 'passkey' };
  }

  /**
   * „Alle Geräte abmelden": entwertet Merk-Geräte UND alle laufenden Sitzungen
   * — einschließlich der eigenen. Vorher hieß die Aktion nur so und beendete
   * keine einzige Sitzung; ein gestohlenes Cookie blieb bis zu 7 Tage gültig.
   */
  async signOutAllDevices(
    user: SessionUser,
    source: InquirySource,
  ): Promise<number> {
    const count = await this.devices.revokeAll(user.id);
    await this.session.invalidateAllSessions(user.id);
    // Die Notbremse räumt auch einen angefangenen TOTP-Einrichtungsdialog weg
    // ([K5]). Sie ist der Griff für „ich vermute ein erbeutetes Cookie" — und
    // genau aus so einem Cookie heraus wird das vorläufige Geheimnis angelegt.
    await this.totp.discardPending(user.id);
    await this.audit.log({
      userId: user.id,
      actor: user.email,
      action: AUDIT_ACTION.devicesAllRevoked,
      objectType: 'User',
      objectId: user.id,
      afterValue: { invalidatedTrustedDevices: count, sessionsEnded: true },
      ip: source.ip,
      userAgent: source.userAgent,
    });
    return count;
  }
}
