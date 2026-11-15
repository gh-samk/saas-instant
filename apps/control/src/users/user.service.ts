import { Injectable, Logger } from '@nestjs/common';
import { baseUrl } from '../common/base-url';
import { ConfigService } from '@nestjs/config';
import type { UserRole, Prisma } from '.prisma/control-client';
import {
  AUDIT_ACTION,
  AuditService,
  type AuditAction,
} from '../audit/audit.service';
import type { InquirySource } from '../common/inquiry-source';
import { PrismaService } from '../prisma/prisma.service';
import { INVITATION_VALID_MS, EmergencyService } from '../auth/emergency.service';
import {
  AddressAlreadyTakenError,
  UserNotFoundError,
  OwnAccountError,
  AccountAlreadyHasAccessError,
  LastAccountError,
} from './user.errors';

/**
 * ===========================================================================
 * DIE NUTZERVERWALTUNG — alle können dasselbe
 * ===========================================================================
 *
 * ES GIBT GENAU EINE ROLLE. Wer Zugang zur Verwaltung hat, darf alles:
 * festschreiben, stornieren, sperren, löschen, weitere Konten eintragen.
 *
 * DAS IST EINE ENTSCHEIDUNG, KEINE AUSLASSUNG. Ein Betrieb mit zwei Personen
 * braucht keine Rechteverwaltung, sondern Vertrauen und einen Nachweis
 * darüber, wer was getan hat. Den Nachweis gibt es seit der ersten Etappe
 * (Audit-Log, R6), und seit Etappe 6 lässt er sich auch lesen. Eine
 * Rechtematrix daneben wäre Pflegeaufwand für eine Unterscheidung, die im
 * Alltag niemand trifft — und jede zusätzliche Rolle ist eine Stelle, an der
 * ein Recht versehentlich zu weit reicht.
 *
 * ZWEI REGELN BLEIBEN, und beide gelten serverseitig:
 *
 * 1. DAS LETZTE AKTIVE KONTO BLEIBT. Ohne es gäbe es niemanden mehr, der ein
 *    neues eintragen könnte; der Weg zurück wäre ein Notfall-Link über die
 *    Kommandozeile. Geprüft wird IN DERSELBEN TRANSAKTION wie die Änderung —
 *    zwei gleichzeitige Entzüge liefen an einer Prüfung davor vorbei.
 * 2. ZUGANG ENTZIEHEN HEISST NICHT LÖSCHEN (R4). Ein gelöschtes Konto verlöre
 *    die Zuordnung seiner Audit-Einträge — und die Frage „wer hat im Mai diese
 *    Rechnung festgeschrieben?" wäre nicht mehr zu beantworten.
 *
 * DAS EIGENE KONTO LÄSST SICH HIER NICHT ABSCHALTEN. Wer das täte, wäre
 * ausgesperrt, ohne dass es jemand anderes rückgängig machen müsste.
 */

/**
 * Der abgeleitete Zustand eines Kontos.
 *
 * `ohne_zugang` heisst: Es gibt das Konto, aber weder Passwort noch Passkey —
 * also keinen Weg hinein. Das ist kein gespeicherter Zustand, sondern eine
 * Ablesung, und genau deshalb kann er nicht falsch stehen.
 *
 * DIE REIHENFOLGE IST WESENTLICH: `gesperrt` schlägt alles. Ein deaktiviertes
 * Konto, das nie eingelöst wurde, ist gesperrt und nicht „eingeladen" — ein
 * Link, den niemand mehr einlösen kann, ist keine Einladung.
 */
export function stateOf(account: {
  deactivatedAt: Date | null;
  passwordHash: string | null;
  _count: { passkeys: number };
}): 'active' | 'without_access' | 'locked' {
  if (account.deactivatedAt !== null) return 'locked';
  if (account.passwordHash === null && account._count.passkeys === 0) {
    return 'without_access';
  }
  return 'active';
}

/**
 * Die Rolle, die jedes eingetragene Konto bekommt.
 *
 * `inhaber` bleibt dem Konto aus der Ersteinrichtung vorbehalten — nicht,
 * weil es mehr dürfte (es darf genau dasselbe), sondern damit im Nachweis
 * erkennbar bleibt, welches Konto am Anfang stand. `mitarbeitend` steht seit
 * einem verworfenen Entwurf im Enum und wird NICHT VERGEBEN; wie
 * `RechnungStatus.ueberfaellig` bleibt der Wert stehen, weil ihn zu
 * entfernen eine nicht-additive Migration wäre.
 */
const ROLE_FOR_NEW = 'administrator' as const;

export interface UserLine {
  id: string;
  name: string;
  username: string;
  email: string;
  /**
   * Die Rolle des Kontos. Sie unterscheidet keine RECHTE — alle Konten können
   * dasselbe —, sondern hält fest, welches am Anfang stand.
   */
  role: string;
  /**
   * Der abgeleitete Zustand — kein gespeichertes Feld.
   *
   * `ohne_zugang` heisst: Konto vorhanden, aber weder Passwort noch Passkey,
   * also keine Möglichkeit, sich anzumelden. Ein Zustand, den niemand pflegen
   * muss, kann auch nicht falsch stehen.
   */
  state: 'active' | 'without_access' | 'locked';
  deactivatedAt: string | null;
  lastLoginAt: string | null;
  /** Ist das die Zeile der anfragenden Person? */
  self: boolean;
}

/**
 * Das Ergebnis eines Eintrags — der Link erscheint GENAU EINMAL.
 *
 * Er steht nur in dieser Antwort. Gespeichert ist ausschliesslich sein
 * SHA-256; wer die Datenbank liest, kann damit nichts einlösen. Geht er
 * verloren, wird ein neuer erzeugt — es gibt keinen Weg, ihn ein zweites Mal
 * anzuzeigen.
 */
export interface AccessResult {
  user: UserLine;
  link: string;
  expiresAt: string;
}

interface Actor {
  userId: string;
  name: string;
}

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly emergency: EmergencyService,
  ) {}

  /**
   * Die Adresse, unter der die Oberflaeche erreichbar ist — DIESELBE Quelle
   * wie bei den Bestaetigungslinks der Einwilligung. Zwei Konfigurationswerte
   * fuer dieselbe Adresse liefen unweigerlich auseinander, und dann zeigte
   * der eine Link ins Leere.
   */
  private baseUrl(): string {
    return baseUrl(this.config);
  }

  /** Alle Konten. Ohne Hashes, ohne Token, ohne Geheimnisse. */
  async overview(actorId: string): Promise<UserLine[]> {
    const lines = await this.prisma.user.findMany({
      orderBy: [{ deactivatedAt: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        username: true,
        email: true,
        role: true,
        deactivatedAt: true,
        lastLoginAt: true,
        passwordHash: true,
        _count: { select: { passkeys: true } },
      },
    });
    return lines.map((z) => ({
      id: z.id,
      name: z.name,
      username: z.username,
      email: z.email,
      role: z.role,
      state: stateOf(z),
      deactivatedAt: z.deactivatedAt?.toISOString() ?? null,
      lastLoginAt: z.lastLoginAt?.toISOString() ?? null,
      self: z.id === actorId,
    }));
  }

  /**
   * Lädt jemanden ein. Der Link erscheint GENAU EINMAL in der Antwort.
   *
   * ES GEHT KEINE MAIL HINAUS — noch nicht. Der Link wird angezeigt und von
   * Hand weitergegeben. Das ist keine Sparsamkeit: Eine Einladungsmail ist
   * eine Transaktionsmail an eine Adresse, die uns noch nicht gehört, und sie
   * braucht eine eigene Vorlage. Sie automatisch zu verschicken, bevor
   * jemand ihren Wortlaut gesehen hat, wäre der falsche Weg herum.
   */
  async register(
    data: { name: string; email: string },
    actor: Actor,
    source: InquirySource,
  ): Promise<AccessResult> {
    const email = data.email.trim().toLowerCase();
    const name = data.name.trim();

    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email }, { username: email }] },
      select: { id: true },
    });
    if (existing) throw new AddressAlreadyTakenError();

    // DAS KONTO ENTSTEHT SOFORT — ohne Passwort, ohne Passkey, ohne zweiten
    // Faktor. Es kann sich damit nicht anmelden: `passwortHash` ist `null`,
    // und der Anmeldeweg prüft gegen einen Hash, den es nicht gibt.
    //
    // DER NUTZERNAME IST DIE ADRESSE. Beide Spalten sind eindeutig, beide
    // taugen zur Anmeldung — sich einen zweiten Namen ausdenken zu lassen,
    // bevor jemand das Konto überhaupt in der Hand hatte, wäre eine
    // Entscheidung an der falschen Stelle. Ändern lässt er sich später.
    const user = await this.prisma.user.create({
      data: {
        name,
        email,
        username: email,
        role: ROLE_FOR_NEW,
        // DER ZWEITE FAKTOR IST VON ANFANG AN DA — sonst ist das Konto eine
        // Sackgasse: Nach dem Passwort verlangt die Anmeldung einen zweiten
        // Faktor, das frische Konto hat aber keinen, und ALLE Wege, einen
        // einzurichten, liegen hinter SitzungGuard. Ohne Sitzung kein Faktor,
        // ohne Faktor keine Sitzung. Eingeladene kamen so nie hinein.
        //
        // Der Code per E-Mail ist hier der richtige erste Faktor: Er ist ohne
        // Gerät und ohne App sofort nutzbar. ABER: Der Einladungslink geht
        // NICHT per Mail hinaus, sondern an die Administration (siehe oben);
        // wer das Passwort setzt, hat das Postfach damit noch nicht bewiesen.
        // Ist die Adresse vertippt, geht der Code an ein fremdes Postfach und
        // die Eingeladene bleibt vor Schritt 2 stecken. Dafür gibt es
        // `berichtigeAdresse` ([Review B1]) — solange das Konto ohne Zugang
        // ist. `anmeldecodeEmail` bleibt NULL und bedeutet „nimm `email`",
        // folgt also einer Berichtigung automatisch.
        //
        // Wer lieber TOTP oder einen Passkey nutzt, richtet sie danach in den
        // Einstellungen ein und kann den Code abschalten.
        loginCodeEnabled: true,
      },
      select: {
        id: true,
        name: true,
        username: true,
        email: true,
        role: true,
        deactivatedAt: true,
        lastLoginAt: true,
        passwordHash: true,
        _count: { select: { passkeys: true } },
      },
    });

    // DER LINK IST EIN NOTFALL-LINK DER ART `passwort` — derselbe Weg, den es
    // seit der ersten Etappe gibt und der geprüft ist. Ein eigener
    // Einladungsweg wäre ein zweiter Token-Mechanismus neben einem
    // funktionierenden, mit eigenen Fehlern an denselben Stellen.
    const link = await this.emergency.generateLink(
      user.username,
      'password',
      actor.name,
      new Date(),
      INVITATION_VALID_MS,
    );

    await this.audit.log({
      userId: actor.userId,
      actor: actor.name,
      action: AUDIT_ACTION.userRegistered,
      objectType: 'User',
      objectId: user.id,
      // KEINE ADRESSE IM NACHWEIS: Das Audit-Log hat keinen Löschweg. Dass
      // ein Konto dazukam, ist die sicherheitsrelevante Angabe — und WELCHES,
      // steht in `objektId`.
      afterValue: { role: ROLE_FOR_NEW },
      ...source,
    });

    this.logger.log(
      `Konto ${user.id} eingetragen, Zugangslink gültig ` +
        `${Math.round(INVITATION_VALID_MS / 3_600_000)} Stunden.`,
    );

    return {
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        email: user.email,
        role: user.role,
        state: stateOf(user),
        deactivatedAt: null,
        lastLoginAt: null,
        self: false,
      },
      link: link.url,
      expiresAt: link.expiresAt.toISOString(),
    };
  }

  /**
   * Erzeugt einen NEUEN Einladungslink für ein Konto, das noch keines
   * eingelöst hat.
   *
   * Der alte bleibt gültig, bis seine Frist um ist — ihn zu entwerten wäre ein
   * zweiter Schreibvorgang für einen Fall, den niemand hat: Wer den Link
   * verliert, hat ihn nicht in fremden Händen.
   *
   * NUR FÜR KONTEN OHNE ZUGANG. Für ein Konto MIT Passwort wäre das ein
   * Passwort-Zurücksetzen durch die Administration — ein anderer Vorgang mit
   * anderen Folgen, und einer, den es hier bewusst nicht gibt.
   */
  /**
   * Berichtigt die Adresse eines Kontos, das noch keinen Zugang hat.
   *
   * [Review B1] Der Einladungslink wird der Administration gezeigt, nicht an
   * die Adresse geschickt. Ein Tippfehler fällt deshalb erst auf, wenn der
   * Anmeldecode ins Leere geht — und dann gab es keinen Weg, ihn zu beheben.
   *
   * NUR IM ZUSTAND `ohne_zugang`: Sobald jemand angemeldet war, gehört die
   * Adresse der Person selbst; die Verwaltung ändert sie dann nicht mehr von
   * aussen. Nutzername und Adresse bleiben identisch, wie beim Eintragen.
   * Offene Zugangslinks hängen an der Konto-ID und bleiben gültig.
   */
  async correctAddress(
    id: string,
    newAddress: string,
    actor: Actor,
    source: InquirySource,
  ): Promise<UserLine> {
    const email = newAddress.trim().toLowerCase();
    const account = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        username: true,
        deactivatedAt: true,
        passwordHash: true,
        _count: { select: { passkeys: true } },
      },
    });
    if (!account) throw new UserNotFoundError();
    if (stateOf(account) !== 'without_access') {
      throw new AccountAlreadyHasAccessError();
    }

    const taken = await this.prisma.user.findFirst({
      where: {
        id: { not: id },
        OR: [{ email }, { username: email }],
      },
      select: { id: true },
    });
    if (taken) throw new AddressAlreadyTakenError();

    const after = await this.prisma.user.update({
      where: { id },
      data: { email, username: email, loginCodeEmail: null },
      select: {
        id: true,
        name: true,
        username: true,
        email: true,
        role: true,
        deactivatedAt: true,
        lastLoginAt: true,
        passwordHash: true,
        _count: { select: { passkeys: true } },
      },
    });

    await this.audit.log({
      userId: actor.userId,
      actor: actor.name,
      action: AUDIT_ACTION.userAddressCorrected,
      objectType: 'User',
      objectId: id,
      // KEINE ADRESSE IM NACHWEIS — wie beim Eintragen.
      afterValue: { state: 'without_access' },
      ...source,
    });

    return {
      id: after.id,
      name: after.name,
      username: after.username,
      email: after.email,
      role: after.role,
      state: stateOf(after),
      deactivatedAt: null,
      lastLoginAt: after.lastLoginAt?.toISOString() ?? null,
      self: after.id === actor.userId,
    };
  }

  async newAccessLink(
    id: string,
    actor: Actor,
    source: InquirySource,
  ): Promise<{ link: string; expiresAt: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        username: true,
        deactivatedAt: true,
        passwordHash: true,
        _count: { select: { passkeys: true } },
      },
    });
    if (!user) throw new UserNotFoundError();
    if (stateOf(user) !== 'without_access') {
      throw new AccountAlreadyHasAccessError();
    }

    const link = await this.emergency.generateLink(
      user.username,
      'password',
      actor.name,
      new Date(),
      INVITATION_VALID_MS,
    );
    await this.audit.log({
      userId: actor.userId,
      actor: actor.name,
      action: AUDIT_ACTION.userRegistered,
      objectType: 'User',
      objectId: id,
      afterValue: { again: true },
      ...source,
    });
    return { link: link.url, expiresAt: link.expiresAt.toISOString() };
  }

  /** Entzieht oder erteilt den Zugang. Das Konto selbst bleibt (R4). */
  async setAccess(
    id: string,
    active: boolean,
    actor: Actor,
    source: InquirySource,
  ): Promise<UserLine> {
    if (id === actor.userId) throw new OwnAccountError();

    return this.update(
      id,
      actor,
      source,
      {
        deactivatedAt: active ? null : new Date(),
        // DIE LAUFENDEN SITZUNGEN ENDEN SOFORT. Dasselbe Mittel wie bei
        // „alle abmelden" und beim Passwortwechsel: Die Generation im
        // Sitzungs-JWT stimmt danach nicht mehr, und das Cookie ist wertlos.
        // Ohne das bliebe ein entzogener Zugang bis zu dreissig Tage
        // bestehen — und weil sich die Sitzung bei Nutzung selbst erneuert,
        // sogar unbegrenzt.
        //
        // AUCH BEIM WIEDERERTEILEN. Wer den Zugang zurückbekommt, meldet sich
        // neu an; eine Sitzung aus der Zeit davor wieder aufleben zu lassen
        // wäre der falsche Weg herum.
        sessionGeneration: { increment: 1 },
      },
      !active,
      active ? AUDIT_ACTION.userReactivated : AUDIT_ACTION.userDeactivated,
    );
  }

  /**
   * Der gemeinsame Schreibweg — mit der Prüfung auf den letzten Administrator
   * IN DERSELBEN TRANSAKTION.
   *
   * Warum nicht davor: Zwei gleichzeitige Entzüge läsen beide „es gibt noch
   * zwei", und danach gäbe es keinen. `SELECT … FOR UPDATE` auf die Zeilen mit
   * Administrationsrechten macht daraus eine Reihenfolge.
   */
  private async update(
    id: string,
    actor: Actor,
    source: InquirySource,
    data: Prisma.UserUpdateInput,
    takesRights: boolean,
    action: AuditAction,
  ): Promise<UserLine> {
    const result = await this.prisma.$transaction(async (tx) => {
      const before = await tx.user.findUnique({
        where: { id },
        select: { id: true, role: true, deactivatedAt: true },
      });
      if (!before) throw new UserNotFoundError();

      if (takesRights) {
        // ALLE AKTIVEN KONTEN, gesperrt für die Dauer der Transaktion.
        //
        // `FOR UPDATE` und nicht bloss ein `count` davor: Zwei gleichzeitige
        // Entzüge läsen beide „es gibt noch zwei", und danach gäbe es keines.
        // Die Sperre macht daraus eine Reihenfolge.
        // NUR ANMELDEFÄHIGE KONTEN ZÄHLEN. „Nicht deaktiviert" allein genügt
        // nicht: Ein gerade eingetragenes Konto, dessen Einladung noch niemand
        // eingelöst hat, hat kein Passwort und kann sich nicht anmelden. Zählte
        // es mit, liesse sich das letzte tatsächlich benutzbare Konto
        // deaktivieren — und niemand käme mehr in die Verwaltung, ausser über
        // die Notfall-CLI im Container.
        //
        // Anmeldefähig ist ein Konto auf GENAU ZWEI Wegen, so wie der
        // auth.controller sie führt:
        //   Weg 1 — Passwort UND ein zweiter Faktor (E-Mail-Code oder TOTP).
        //   Weg 2 — ein Passkey allein; er ersetzt Passwort und zweiten
        //           Faktor zugleich und braucht deshalb kein Passwort.
        // Ein Konto mit Passwort, aber ohne zweiten Faktor kommt nicht durch:
        // Die Anmeldung verlangt nach dem Passwort einen Faktor und bietet
        // eine leere Auswahl an.
        const remaining = await tx.$queryRaw<{ id: string }[]>`
          SELECT b."id" FROM "User" b
          WHERE b."deactivatedAt" IS NULL
            AND (
              EXISTS (
                SELECT 1 FROM "PasskeyCredential" p
                WHERE p."userId" = b."id"
              )
              OR (
                b."passwordHash" IS NOT NULL
                AND (b."loginCodeEnabled" OR b."totpSecret" IS NOT NULL)
              )
            )
          FOR UPDATE OF b`;
        const withoutThis = remaining.filter((z) => z.id !== id);
        if (before.deactivatedAt === null && withoutThis.length === 0) {
          return { rejected: true as const };
        }
      }

      const after = await tx.user.update({
        where: { id },
        data: data,
        select: {
          id: true,
          name: true,
          username: true,
          email: true,
          role: true,
          deactivatedAt: true,
          lastLoginAt: true,
          passwordHash: true,
          _count: { select: { passkeys: true } },
        },
      });
      return { rejected: false as const, before, after };
    });

    if (result.rejected) {
      // DIE ABLEHNUNG STEHT IM NACHWEIS. Dass jemand es vorhatte, ist selbst
      // eine Auskunft — genau wie bei `faktor.entfernen_abgelehnt`.
      await this.audit.log({
        userId: actor.userId,
        actor: actor.name,
        action: AUDIT_ACTION.userLastAccountRejected,
        objectType: 'User',
        objectId: id,
        ...source,
      });
      throw new LastAccountError();
    }

    await this.audit.log({
      userId: actor.userId,
      actor: actor.name,
      action,
      objectType: 'User',
      objectId: id,
      beforeValue: {
        role: result.before.role,
        active: result.before.deactivatedAt === null,
      },
      afterValue: {
        role: result.after.role,
        active: result.after.deactivatedAt === null,
      },
      ...source,
    });

    return {
      id: result.after.id,
      name: result.after.name,
      username: result.after.username,
      email: result.after.email,
      role: result.after.role,
      state: stateOf(result.after),
      deactivatedAt: result.after.deactivatedAt?.toISOString() ?? null,
      lastLoginAt:
        result.after.lastLoginAt?.toISOString() ?? null,
      self: false,
    };
  }
}
