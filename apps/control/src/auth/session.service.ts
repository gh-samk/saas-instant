import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  SESSION_RENEWAL_AFTER_MS,
  SESSION_MAX_AGE_MS,
  SESSION_ABSOLUTE_MAX_MS,
} from '../common/cookies';
import { PrismaService } from '../prisma/prisma.service';
import { authModeFrom, envFrom } from '../sso/sso-settings';

/** Der an den Request gehängte, angemeldete Benutzer. */
export interface SessionUser {
  id: string;
  name: string;
  username: string;
  email: string;
  role: string;
}

/** Nutzlast des Sitzungs-JWT. */
interface SessionPayload {
  sub: string;
  /** Sitzungs-Generation des Kontos zum Zeitpunkt der Ausstellung. */
  gen: number;
  /**
   * Wann sich der Benutzer zuletzt WIRKLICH ausgewiesen hat (Sekunden seit
   * Epoche) — Passwort plus zweiter Faktor, Passkey oder Notfall-Link.
   *
   * BEWUSST GETRENNT VON `iat`. Eine Erneuerung schreibt ein frisches `iat`,
   * übernimmt `auth_time` aber unverändert. Wäre das Frische-Fenster an `iat`
   * gebunden, würde es sich mit jeder Erneuerung selbst zurücksetzen: die
   * Erneuerung greift nach 24 Stunden, das Cookie lebt 30 Tage — jede real
   * benutzte Sitzung wäre damit ab Tag 1 dauerhaft „frisch", und der Nachweis
   * vor heiklen Aktionen entfiele für immer. Genau das war Befund [K1].
   */
  auth_time?: number;
  /**
   * Beginn der Sitzung (Sekunden seit Epoche): der Anmeldevorgang, aus dem alle
   * Erneuerungen hervorgehen. Wird beim Erneuern UNVERÄNDERT übernommen und
   * begrenzt die Gesamtdauer (`SESSION_ABSOLUTE_MAX_MS`). Fehlt der Claim,
   * gilt das Token als ungültig.
   */
  sst?: number;
  /**
   * Kennung der SSO-Sitzung (`SsoSession.id`), nur bei einer Anmeldung über das
   * Portal. Über sie lässt sich die Sitzung serverseitig beenden (Front-Channel-
   * Logout) und der Step-up-Nachweis ablesen.
   */
  ssn?: string;
  /** Ausstellungszeitpunkt in Sekunden seit Epoche, von jsonwebtoken gesetzt. */
  iat?: number;
}

/** Eine aufgelöste, gültige Sitzung. */
export interface ResolvedSession {
  user: SessionUser;
  /**
   * Wann dieses TOKEN ausgestellt wurde (`iat`). Steuert ausschließlich, wann
   * die Sitzung erneuert wird — niemals das Frische-Fenster.
   */
  issuedAt: Date | null;
  /**
   * Wann sich der Benutzer zuletzt wirklich ausgewiesen hat (`auth_time`).
   * Einzige Grundlage für das Frische-Fenster bei heiklen Aktionen.
   * `null` = kein Nachweiszeitpunkt im Token, gilt als NICHT frisch.
   */
  evidenceAt: Date | null;
  /** Beginn der Sitzung (erste Anmeldung), für die Erneuerung. */
  sessionStartedAt: Date;
  /**
   * Rolle für die Rechteprüfung. Im Modus `single` IMMER `admin`, auch wenn in
   * der Datenbank etwas anderes steht (Rest aus einem früheren Portalbetrieb).
   */
  accessRole: 'admin' | 'staff';
  /** Die SSO-Sitzung hinter diesem Token, oder `null` bei lokaler Anmeldung. */
  ssoSession: ResolvedSsoSession | null;
}

/** Was die Verwaltung über eine Portal-Sitzung weiß. */
export interface ResolvedSsoSession {
  id: string;
  /** Portal-Sitzungs-ID. */
  sid: string;
  /** Zeitpunkt des letzten gelungenen Step-ups, oder `null`. */
  stepUpAt: Date | null;
}

/**
 * Höchstdauer einer Portal-Sitzung: zwölf Stunden, ohne Verlängerung darüber
 * hinaus. Das Portal kann eine Rolle entziehen, ohne dass die Verwaltung es
 * mitbekommt; nach spätestens zwölf Stunden muss die Sitzung durch das Portal
 * (still, solange dort eine Sitzung läuft) und übernimmt die Rolle neu.
 */
export const SSO_SESSION_MAX_MS = 12 * 60 * 60 * 1000;

/** Mindestlänge des JWT-Geheimnisses. */
export const JWT_SECRET_MIN_LENGTH = 32;

/** Beispielwerte aus .env.example / Compose, die nie produktiv gelten dürfen. */
const JWT_SECRET_PLACEHOLDERS = new Set([
  'change-me-example-jwt-secret',
  'changeme',
  'change-me',
  'secret',
]);

/**
 * Wirft, wenn das JWT-Geheimnis fehlt, zu kurz oder ein Platzhalter ist.
 * In NODE_ENV=test entfällt die Prüfung (Test-Doppel nutzen kurze Werte).
 */
export function assertJwtSecret(value: string | undefined): string {
  if (!value) {
    throw new Error('JWT_SECRET ist nicht gesetzt.');
  }
  if (process.env['NODE_ENV'] === 'test') return value;
  if (
    value.length < JWT_SECRET_MIN_LENGTH ||
    JWT_SECRET_PLACEHOLDERS.has(value.toLowerCase()) ||
    /^change-?me/i.test(value)
  ) {
    throw new Error(
      `JWT_SECRET ist zu schwach: mindestens ${JWT_SECRET_MIN_LENGTH} Zeichen und kein Beispielwert.`,
    );
  }
  return value;
}

/**
 * Stellt Sitzungs-Token aus und löst sie wieder auf. Die Sitzung ist ein
 * signiertes JWT im httpOnly-Cookie `sitzung` — keine Sitzungstabelle,
 * analog zur Kundenanwendung.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private secret(): string {
    return assertJwtSecret(this.config.get<string>('JWT_SECRET'));
  }

  /**
   * Signiert das Sitzungs-JWT (30 Tage) samt der aktuellen Sitzungs-Generation
   * des Kontos. Wird die Generation später hochgezählt, verfällt dieses Token
   * sofort — auch wenn seine 30 Tage noch nicht um sind.
   *
   * Die Laufzeit des JWT und die des Cookies MÜSSEN übereinstimmen; deshalb
   * kommt sie aus derselben Konstante wie `sitzungsCookieOptionen`. Liefen sie
   * auseinander, gäbe es entweder ein Cookie ohne gültiges Token (Abmeldung
   * ohne Anlass) oder ein Token, das das Cookie überlebt (unnötig lang gültig).
   *
   * `nachweisAm` MUSS beim Erneuern durchgereicht werden und darf NUR bei einem
   * echten Anmeldevorgang fehlen (dann zählt jetzt). Wer das vergisst, macht
   * jede erneuerte Sitzung wieder „frisch" — siehe `auth_time`.
   */
  async createToken(
    userId: string,
    evidenceAt?: Date | null,
    sessionStartedAt?: Date,
    ssoSessionId?: string,
  ): Promise<string> {
    const now = new Date();
    const started = sessionStartedAt ?? now;
    const absoluteMax =
      ssoSessionId === undefined ? SESSION_ABSOLUTE_MAX_MS : SSO_SESSION_MAX_MS;
    const remainingMs = Math.min(
      SESSION_MAX_AGE_MS,
      started.getTime() + absoluteMax - now.getTime(),
    );
    if (remainingMs <= 0) {
      throw new UnauthorizedException(
        'Sitzung ungültig oder abgelaufen.',
      );
    }
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { sessionGeneration: true },
    });
    if (!account) {
      throw new UnauthorizedException('Konto nicht gefunden.');
    }
    // Drei Fälle, und der Unterschied zwischen den letzten beiden entscheidet:
    //   undefined → frische Anmeldung, JETZT ist der Nachweis
    //   Date      → Erneuerung, der alte Nachweiszeitpunkt wird übernommen
    //   null      → das alte Token trug gar keinen Nachweiszeitpunkt; dann
    //               trägt das neue auch keinen und bleibt „nicht frisch".
    //               Würde hier `?? new Date()` stehen, machte die Erneuerung ein
    //               nachweisloses Token still zu einem frischen.
    const payload: Record<string, unknown> = {
      sub: userId,
      gen: account.sessionGeneration,
      sst: Math.floor(started.getTime() / 1000),
    };
    if (ssoSessionId !== undefined) payload['ssn'] = ssoSessionId;
    if (evidenceAt !== null) {
      payload['auth_time'] = Math.floor(
        (evidenceAt ?? new Date()).getTime() / 1000,
      );
    }
    return this.jwt.signAsync(payload, {
      secret: this.secret(),
      expiresIn: `${Math.max(1, Math.floor(remainingMs / 1000))}s`,
    });
  }

  /**
   * Entwertet ALLE laufenden Sitzungen des Kontos, indem die Generation
   * hochgezählt wird. Atomar in der Datenbank (`increment`), damit zwei
   * gleichzeitige Auslöser sich nicht gegenseitig überschreiben.
   */
  async invalidateAllSessions(userId: string): Promise<number> {
    const account = await this.prisma.user.update({
      where: { id: userId },
      data: { sessionGeneration: { increment: 1 } },
      select: { sessionGeneration: true },
    });
    return account.sessionGeneration;
  }

  /**
   * Ist dieses Token alt genug, um bei Nutzung erneuert zu werden?
   *
   * `null` (Token ohne `iat`) heißt NEIN: ohne Ausstellungszeitpunkt lässt sich
   * das Alter nicht bestimmen, und ein Token blind zu verlängern wäre die
   * falsche Richtung im Zweifel.
   */
  needsRenewal(
    issuedAt: Date | null,
    now: Date = new Date(),
  ): boolean {
    if (!issuedAt) return false;
    return now.getTime() - issuedAt.getTime() >= SESSION_RENEWAL_AFTER_MS;
  }

  /** Prüft ein Sitzungs-JWT und lädt den Benutzer. Wirft bei jedem Fehler 401. */
  async resolve(token: string | undefined): Promise<ResolvedSession> {
    if (!token) {
      throw new UnauthorizedException('Nicht angemeldet.');
    }
    let payload: SessionPayload;
    try {
      payload = await this.jwt.verifyAsync<SessionPayload>(token, {
        secret: this.secret(),
      });
    } catch {
      throw new UnauthorizedException('Sitzung ungültig oder abgelaufen.');
    }

    // `sub` MUSS eine Zeichenkette sein, bevor damit abgefragt wird. Ohne diese
    // Prüfung landete ein anonym beschaffbarer Vorgangstoken (der trägt
    // `benutzerId`, kein `sub`) im Cookie `sitzung` und erzeugte einen
    // PrismaClientValidationError — also 500 statt 401, samt Stapelspur im Log
    // ([W3]). Kein Zugriffsgewinn, aber ein unauthentifizierter Weg, Fehlerpfade
    // und Logs zu fluten.
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new UnauthorizedException('Sitzung ungültig oder abgelaufen.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        name: true,
        username: true,
        email: true,
        role: true,
        sessionGeneration: true,
        deactivatedAt: true,
        accessRole: true,
        emergency: true,
      },
    });
    if (!user) {
      throw new UnauthorizedException('Konto nicht gefunden.');
    }

    // Modus `portal`: Sitzungen entstehen durch das Portal. Ein Token ohne
    // SSO-Sitzung (lokale Anmeldung) gilt nur für Konten mit Notzugang. Im
    // Modus `single` dagegen gibt es keine SSO-Sitzungen.
    const portal = authModeFrom(envFrom(this.config)) === 'portal';
    let ssoSession: ResolvedSsoSession | null = null;
    if (payload.ssn !== undefined) {
      if (!portal || typeof payload.ssn !== 'string') {
        throw new UnauthorizedException('Sitzung ungültig oder abgelaufen.');
      }
      const row = await this.prisma.ssoSession.findUnique({
        where: { id: payload.ssn },
        select: {
          id: true,
          userId: true,
          ssoSid: true,
          stepUpAt: true,
          endedAt: true,
        },
      });
      if (!row || row.userId !== user.id || row.endedAt !== null) {
        throw new UnauthorizedException(
          'Die Sitzung wurde beendet. Bitte erneut anmelden.',
        );
      }
      ssoSession = { id: row.id, sid: row.ssoSid, stepUpAt: row.stepUpAt };
    } else if (portal && !user.emergency) {
      throw new UnauthorizedException('Sitzung ungültig oder abgelaufen.');
    }

    // ZUGANG ENTZOGEN: Die Sitzung endet SOFORT, nicht erst beim nächsten
    // Anmelden. Das Bumpen der Sitzungs-Generation beim Deaktivieren tut
    // dasselbe und ist der schnellere Weg; diese Prüfung ist die zweite
    // Sicherung. Zwei unabhängige Wege, weil ein entzogener Zugang die
    // Handlung ist, bei der ein Aussetzer am teuersten wäre.
    if (user.deactivatedAt !== null) {
      throw new UnauthorizedException(
        'Der Zugang zu diesem Konto wurde entzogen.',
      );
    }

    // Generation vergleichen: nach Passwortwechsel, Passkey-Änderung oder
    // „alle abmelden" ist ein älteres Token wertlos. Fehlt `gen` ganz, stammt
    // das Token aus einer früheren Fassung und gilt ebenfalls nicht mehr.
    if (payload.gen !== user.sessionGeneration) {
      throw new UnauthorizedException(
        'Die Sitzung wurde beendet. Bitte erneut anmelden.',
      );
    }

    // Absolute Obergrenze: auch eine laufend erneuerte Sitzung endet spätestens
    // `SESSION_ABSOLUTE_MAX_MS` nach der Anmeldung. Ohne `sst` (alte Fassung)
    // gilt das Token nicht mehr.
    if (
      typeof payload.sst !== 'number' ||
      Date.now() - payload.sst * 1000 >=
        (ssoSession === null ? SESSION_ABSOLUTE_MAX_MS : SSO_SESSION_MAX_MS)
    ) {
      throw new UnauthorizedException('Sitzung ungültig oder abgelaufen.');
    }

    const {
      sessionGeneration: _gen,
      deactivatedAt: _deactivated,
      accessRole: storedRole,
      emergency: _emergency,
      ...withoutGeneration
    } = user;
    // Fehlt `auth_time`, gilt die Sitzung als NICHT frisch — im Zweifel wird der
    // zweite Faktor verlangt, nicht darauf verzichtet. Das deckt auch Token aus
    // einer früheren Fassung ab, die den Claim noch nicht kennen.
    return {
      user: withoutGeneration,
      issuedAt:
        typeof payload.iat === 'number' ? new Date(payload.iat * 1000) : null,
      sessionStartedAt: new Date(payload.sst * 1000),
      accessRole: portal && storedRole === 'staff' ? 'staff' : 'admin',
      ssoSession,
      evidenceAt:
        typeof payload.auth_time === 'number'
          ? new Date(payload.auth_time * 1000)
          : null,
    };
  }
}
