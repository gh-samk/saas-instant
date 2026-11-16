import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_URL_DEFAULT } from '../common/app-defaults';
import { generateToken, hashToken } from '../common/one-time-token';
import { hashPassword } from '@saas-instant/auth-core';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import type { InquirySource } from '../common/inquiry-source';
import { LoginFailedError } from '../common/errors/business-error';
import { PrismaService } from '../prisma/prisma.service';
import { DeviceService } from './device.service';
import { SessionService } from './session.service';

/** Gültigkeitsdauer eines Notfall-Links: 15 Minuten. */
export const EMERGENCY_VALID_MS = 15 * 60 * 1000;

/**
 * Gültigkeitsdauer eines EINLADUNGSLINKS: sieben Tage.
 *
 * Länger als der Notfall-Link, und dafür gibt es einen Grund: Beim Notfall
 * steht jemand daneben und tippt sofort. Eine Einladung wird weitergegeben —
 * per Chat, im Gespräch, später am Tag. Fünfzehn Minuten wären eine Frist, die
 * in der Praxis fast immer verstrichen ist, und die Folge wäre nicht mehr
 * Sicherheit, sondern eine Kette neu erzeugter Links.
 *
 * Sieben Tage sind trotzdem eine Frist: Ein vergessener Link im Chatverlauf
 * ist nach einer Woche wertlos. Und der Link führt nirgends hin ausser auf
 * „setze ein Passwort für ein Konto, das noch keines hat" — es gibt hinter ihm
 * keine Daten zu sehen.
 */
export const INVITATION_VALID_MS = 7 * 24 * 60 * 60 * 1000;

/** Zweck eines Notfall-Links. */
export type EmergencyKind = 'passkey' | 'password';

/** Pfad der Oberfläche je Zweck. */
const PATH_PER_KIND: Record<EmergencyKind, string> = {
  passkey: '/emergency-enrollment',
  password: '/emergency-password',
};

/** Ergebnis der Token-Erzeugung. Der Klartext erscheint nur einmal auf stdout. */
export interface GeneratedEmergencyLink {
  url: string;
  expiresAt: Date;
  kind: EmergencyKind;
}

/** Ein geprüfter, noch gültiger Notfall-Token samt zugehörigem Konto. */
export interface VerifiedEmergencyToken {
  registrationId: string;
  userId: string;
  kind: EmergencyKind;
  username: string;
  email: string;
  name: string;
  role: string;
  /**
   * Restlaufzeit in Sekunden, aufgerundet. Bewusst Restsekunden statt
   * Zeitstempel — dieselbe Begründung wie bei der Kontosperre: kein ISO-Datum,
   * keine Abhängigkeit von der Uhr des Clients.
   */
  secondsRemaining: number;
}

/**
 * Die Mechanik steht seit [A.35] in `common/one-time-token.ts` — sie wird jetzt
 * von zwei Wegen gebraucht. Diese Abkuerzung bleibt, damit die Aufrufe hier
 * unveraendert lesbar sind; die Tests dieser Datei mussten dafuer nicht
 * angefasst werden, und genau das ist der Beleg, dass sich nichts am
 * Verhalten geaendert hat.
 */
function hash(token: string): string {
  return hashToken(token);
}

/**
 * Notfallzugang: einmalige, an ein Konto gebundene Links mit 15 Minuten
 * Gültigkeit — entweder zum Anlegen eines Passkeys oder zum Setzen eines
 * neuen Passworts.
 *
 * Beides geht nur im Browser: einen Passkey kann der Server nicht erzeugen,
 * und ein Passwort darf niemals über das Terminal oder Container-Logs laufen.
 * Der Server öffnet deshalb nur den Weg dorthin.
 */
@Injectable()
export class EmergencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly devices: DeviceService,
    private readonly session: SessionService,
  ) {}

  /**
   * Erzeugt einen Notfall-Link für die angegebene Kennung (Nutzername oder
   * E-Mail). Wirft, wenn es die Kennung nicht gibt — im Terminal ist eine
   * klare Fehlermeldung nützlicher als eine neutrale Antwort.
   */
  /**
   * Markiert das Konto als NOTZUGANG (`emergency = true`).
   *
   * Nur die Notfallkommandos der Kommandozeile rufen das auf. Im Modus
   * `portal` darf sich ausschließlich ein so markiertes Konto lokal anmelden —
   * der Weg zurück in die Verwaltung, wenn das Portal nicht erreichbar ist.
   * Wer den Container bedienen kann, kann das ohnehin; eine Oberfläche, die
   * Notzugänge vergibt, gibt es bewusst nicht.
   */
  async markEmergencyAccount(identifier: string): Promise<void> {
    const cleaned = identifier.trim().toLowerCase();
    await this.prisma.user.updateMany({
      where: { OR: [{ username: cleaned }, { email: cleaned }] },
      data: { emergency: true },
    });
  }

  async generateLink(
    identifier: string,
    kind: EmergencyKind,
    actor: string,
    now: Date = new Date(),
    validMs: number = EMERGENCY_VALID_MS,
  ): Promise<GeneratedEmergencyLink> {
    const cleaned = identifier.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ username: cleaned }, { email: cleaned }] },
      select: { id: true, username: true },
    });
    if (!user) {
      throw new NotFoundException(
        `Es gibt kein Konto mit der Kennung "${identifier}".`,
      );
    }

    // Ältere, noch offene Links des Kontos werden entwertet (nicht gelöscht):
    // es gilt immer nur der zuletzt erzeugte.
    await this.invalidateOpenLinks(user.id, now);

    const token = generateToken();
    const expiresAt = new Date(now.getTime() + validMs);
    const entry = await this.prisma.emergencyEnrollment.create({
      data: {
        userId: user.id,
        kind,
        tokenHash: hash(token),
        createdAt: now,
        expiresAt,
      },
      select: { id: true },
    });

    await this.audit.log({
      userId: user.id,
      actor,
      action:
        kind === 'password'
          ? AUDIT_ACTION.emergencyPasswordGenerated
          : AUDIT_ACTION.emergencyEnrollmentGenerated,
      objectType: 'EmergencyEnrollment',
      objectId: entry.id,
      afterValue: {
        kind,
        forAccount: user.username,
        validMinutes: Math.round(validMs / 60000),
      },
      ip: null,
      userAgent: null,
    });

    const base = this.config.get<string>(
      'CONTROL_APP_URL',
      APP_URL_DEFAULT,
    );
    return {
      url: `${base.replace(/\/+$/, '')}${PATH_PER_KIND[kind]}?token=${token}`,
      expiresAt,
      kind,
    };
  }

  /**
   * Prüft einen Token, ohne ihn zu verbrauchen (für die Anzeige der Seite).
   * Liefert null, wenn er unbekannt, abgelaufen, verbraucht oder für einen
   * anderen Zweck ausgestellt ist.
   */
  async check(
    token: string,
    expectedKind: EmergencyKind,
    now: Date = new Date(),
  ): Promise<VerifiedEmergencyToken | null> {
    const entry = await this.prisma.emergencyEnrollment.findUnique({
      where: { tokenHash: hash(token) },
      select: {
        id: true,
        userId: true,
        kind: true,
        expiresAt: true,
        redeemedAt: true,
        user: {
          select: { username: true, email: true, name: true, role: true },
        },
      },
    });
    if (!entry) return null;
    if (entry.kind !== expectedKind) return null;
    if (entry.redeemedAt !== null) return null;

    const remainingMs = entry.expiresAt.getTime() - now.getTime();
    if (remainingMs <= 0) return null;

    return {
      registrationId: entry.id,
      userId: entry.userId,
      kind: entry.kind,
      username: entry.user.username,
      email: entry.user.email,
      name: entry.user.name,
      role: entry.user.role,
      secondsRemaining: Math.ceil(remainingMs / 1000),
    };
  }

  /**
   * Reserviert einen Token, BEVOR eine nachgelagerte Prüfung läuft.
   *
   * Das bedingte `updateMany` ist ein einzelnes UPDATE und damit atomar: von
   * zwei gleichzeitigen Aufrufen trifft genau einer eine Zeile. Ohne diese
   * Reservierung kämen beide durch `pruefe()`, beide legten einen Passkey an,
   * und der zweite Durchlauf entwertete über die Sitzungs-Generation die
   * gerade erst ausgestellte Sitzung des ersten.
   *
   * Schlägt die nachgelagerte Prüfung fehl, gibt `gibFrei()` den Token wieder
   * frei — ein 15-Minuten-Link darf nicht an einem Tippfehler verbrennen.
   */
  async reserve(
    token: string,
    kind: EmergencyKind,
    now: Date = new Date(),
  ): Promise<VerifiedEmergencyToken> {
    const invalid = new LoginFailedError(
      'Dieser Link ist ungültig, abgelaufen oder bereits verwendet.',
    );

    const verified = await this.check(token, kind, now);
    if (!verified) throw invalid;

    const result = await this.prisma.emergencyEnrollment.updateMany({
      where: { id: verified.registrationId, redeemedAt: null },
      data: { redeemedAt: now },
    });
    if (result.count !== 1) throw invalid;

    return verified;
  }

  /** Entwertet alle noch offenen Links des Kontos (Markierung, kein Löschen). */
  private async invalidateOpenLinks(userId: string, now: Date): Promise<void> {
    await this.prisma.emergencyEnrollment.updateMany({
      where: { userId, redeemedAt: null },
      data: { redeemedAt: now },
    });
  }

  /** Schreibt den Audit-Eintrag zu einer bestätigten Einlösung. */
  async confirmRedemption(
    verified: VerifiedEmergencyToken,
    source: InquirySource,
  ): Promise<void> {
    // Mit der Einlösung sind auch alle anderen offenen Links des Kontos tot.
    await this.invalidateOpenLinks(verified.userId, new Date());
    await this.audit.log({
      userId: verified.userId,
      actor: verified.username,
      action:
        verified.kind === 'password'
          ? AUDIT_ACTION.emergencyPasswordRedeemed
          : AUDIT_ACTION.emergencyEnrollmentRedeemed,
      objectType: 'EmergencyEnrollment',
      objectId: verified.registrationId,
      beforeValue: { kind: verified.kind, redeemed: false },
      afterValue: { kind: verified.kind, redeemed: true },
      ip: source.ip,
      userAgent: source.userAgent,
    });
  }

  /**
   * Nimmt eine Reservierung zurück, wenn die nachgelagerte Prüfung scheiterte.
   * Bewusst OHNE Audit-Eintrag: es wurde nichts eingelöst, und ein Eintrag
   * „eingelöst" wäre schlicht falsch.
   */
  async release(registrationId: string): Promise<void> {
    await this.prisma.emergencyEnrollment.update({
      where: { id: registrationId },
      data: { redeemedAt: null },
    });
  }

  /**
   * Löst einen Token in einem Zug ein — für Wege ohne nachgelagerte Prüfung.
   * Reservierung und Bestätigung fallen hier zusammen.
   */
  async resolve(
    token: string,
    kind: EmergencyKind,
    source: InquirySource,
    now: Date = new Date(),
  ): Promise<VerifiedEmergencyToken> {
    const verified = await this.reserve(token, kind, now);
    await this.confirmRedemption(verified, source);
    return verified;
  }

  /**
   * Löst einen Passwort-Link ein und setzt das neue Passwort.
   *
   * Bewusst OHNE anschließende Sitzung: der Benutzer meldet sich danach regulär
   * mit Passwort UND zweitem Faktor an. Ein Passwort-Link allein darf niemals
   * ein vollständiger Zugang sein.
   *
   * Alle Merk-Geräte werden dabei entwertet — wer das Passwort ändert, soll
   * keine Browser im Umlauf lassen, die den zweiten Faktor überspringen.
   */
  async setPassword(
    token: string,
    newPassword: string,
    source: InquirySource,
  ): Promise<{ username: string }> {
    const verified = await this.resolve(token, 'password', source);

    const passwordHash = await hashPassword(newPassword);
    await this.prisma.user.update({
      where: { id: verified.userId },
      data: {
        passwordHash,
        failedAttempts: 0,
        lockedUntil: null,
        // Wie in `ZugangService.setzePasswort` ([K5]): ein angefangener
        // TOTP-Einrichtungsdialog überlebt den Passwortwechsel nicht. Hier wiegt
        // das schwerer als dort — der Notfall-Link wird gerade dann gezogen,
        // wenn ein Missbrauch im Raum steht.
        totpSecretPending: null,
        totpPendingValidUntil: null,
      },
    });
    const invalidated = await this.devices.revokeAll(verified.userId);
    // Auch laufende Sitzungen enden: wer das Passwort per Notfall-Link
    // zurücksetzt, hat womöglich genau deshalb den Verdacht auf Missbrauch.
    await this.session.invalidateAllSessions(verified.userId);

    // Im Audit-Log steht NUR die Tatsache der Änderung — niemals das Passwort
    // und niemals der Hash, weder vorher noch nachher.
    await this.audit.log({
      userId: verified.userId,
      actor: verified.username,
      action: AUDIT_ACTION.passwordSet,
      objectType: 'User',
      objectId: verified.userId,
      beforeValue: { updated: false },
      afterValue: {
        updated: true,
        viaEmergencyLink: true,
        invalidatedTrustedDevices: invalidated,
      },
      ip: source.ip,
      userAgent: source.userAgent,
    });

    return { username: verified.username };
  }
}
