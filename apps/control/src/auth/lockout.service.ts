import { Injectable, NotFoundException } from '@nestjs/common';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import type { InquirySource } from '../common/inquiry-source';
import { AccountLockedError } from '../common/errors/business-error';
import { PrismaService } from '../prisma/prisma.service';
import {
  LOCKOUT_DURATION_MS,
  MAX_FAILED_ATTEMPTS,
  lockoutRemainingSeconds,
} from '@saas-instant/auth-core';

// Konstanten und Rechenregel wohnen in `@saas-instant/auth-core`; hier bleiben
// sie unter den bisherigen Namen erreichbar.
export { LOCKOUT_DURATION_MS, MAX_FAILED_ATTEMPTS };

/** Kontostand für die Sperrprüfung. */
export interface LockoutState {
  id: string;
  username: string;
  email: string;
  failedAttempts: number;
  lockedUntil: Date | null;
}

/**
 * Zählt Fehlversuche und verwaltet die selbstheilende Kontosperre.
 */
@Injectable()
export class LockoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Restsekunden der Sperre, oder 0 wenn das Konto nicht (mehr) gesperrt ist.
   * Bewusst aufgerundet: „noch 0 Sekunden" wäre für den Aufrufer irreführend.
   */
  remainingSeconds(lockedUntil: Date | null, now: Date = new Date()): number {
    return lockoutRemainingSeconds(lockedUntil, now);
  }

  /** Wirft, solange das Konto gesperrt ist. Nach Ablauf passiert nichts. */
  checkNotLocked(user: LockoutState, now: Date = new Date()): void {
    const seconds = this.remainingSeconds(user.lockedUntil, now);
    if (seconds > 0) {
      throw new AccountLockedError(seconds);
    }
  }

  /**
   * Verbucht einen Fehlversuch und gibt die Restsekunden einer dadurch
   * bestehenden Sperre zurück (0, wenn nicht gesperrt).
   *
   * Das Hochzählen passiert in EINEM UPDATE, das den alten Spaltenwert liest
   * und fortschreibt (`"failedAttempts" + 1`) — nicht in JavaScript aus einem
   * vorher gelesenen Snapshot. Postgres serialisiert gleichzeitige UPDATEs auf
   * dieselbe Zeile, daher bekommt jeder parallele Aufruf einen eigenen, um eins
   * höheren Wert. Ein Angreifer kann seine Rateversuche also nicht bündeln, um
   * den Zähler auf 1 festzunageln.
   *
   * Dasselbe Prinzip wie beim bedingten `updateMany` in
   * `wiederherstellungscode.service.ts`: die Datenbank entscheidet, nicht die
   * Anwendung.
   */
  async recordFailedAttempt(
    user: LockoutState,
    source: InquirySource,
    now: Date = new Date(),
  ): Promise<number> {
    const lockoutEnd = new Date(now.getTime() + LOCKOUT_DURATION_MS);

    // Eine abgelaufene Sperre setzt den Zähler zurück auf 1, damit ein
    // Fehlversuch von vor Wochen nicht mitzählt. Beide CASE-Zweige lesen die
    // ALTEN Spaltenwerte der Zeile — so ist es in SQL definiert.
    //
    // `::timestamptz AT TIME ZONE 'UTC'` statt `::timestamp`: ein blosses
    // `::timestamp` rechnet den Parameter in die Zeitzone der DATENBANKSITZUNG
    // um. Steht dort TZ/PGTZ auf etwas anderes als UTC, verschöbe sich sowohl
    // der Ablaufvergleich als auch die Sperrdauer. Die Spalten enthalten UTC
    // (so legt Prisma Dates in timestamp-Spalten ab), also wird hier
    // ausdrücklich nach UTC gewandelt — unabhängig von der Sitzung.
    const lines = await this.prisma.$queryRaw<
      { failedAttempts: number; lockedUntil: Date | null }[]
    >`
      UPDATE "User"
      SET
        "failedAttempts" = CASE
          WHEN "lockedUntil" IS NOT NULL
           AND "lockedUntil" <= (${now}::timestamptz AT TIME ZONE 'UTC')
            THEN 1
          ELSE "failedAttempts" + 1
        END,
        "lockedUntil" = CASE
          WHEN (CASE
                  WHEN "lockedUntil" IS NOT NULL
                   AND "lockedUntil" <= (${now}::timestamptz AT TIME ZONE 'UTC')
                    THEN 1
                  ELSE "failedAttempts" + 1
                END) >= ${MAX_FAILED_ATTEMPTS}
            THEN (${lockoutEnd}::timestamptz AT TIME ZONE 'UTC')
          ELSE NULL
        END
      WHERE "id" = ${user.id}
      RETURNING "failedAttempts", "lockedUntil"
    `;

    const state = lines[0];
    if (!state) {
      // Konto zwischenzeitlich gelöscht: kein stiller Durchlauf.
      throw new NotFoundException('Konto nicht gefunden.');
    }

    // Der Zähler wächst streng um eins, also trifft GENAU EIN Aufruf den
    // Schwellenwert — auch bei gebündelten Anfragen gibt es damit genau einen
    // Sperr-Eintrag im Audit-Log.
    if (state.failedAttempts === MAX_FAILED_ATTEMPTS) {
      await this.audit.log({
        userId: user.id,
        actor: user.username,
        action: AUDIT_ACTION.accountLocked,
        objectType: 'User',
        objectId: user.id,
        beforeValue: { failedAttempts: MAX_FAILED_ATTEMPTS - 1, locked: false },
        afterValue: {
          failedAttempts: state.failedAttempts,
          locked: true,
          lockoutDurationSeconds: LOCKOUT_DURATION_MS / 1000,
        },
        ip: source.ip,
        userAgent: source.userAgent,
      });
    }

    return this.remainingSeconds(state.lockedUntil, now);
  }

  /** Setzt Zähler und Sperre zurück (nach erfolgreicher Anmeldung oder per CLI). */
  async setBack(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { failedAttempts: 0, lockedUntil: null },
    });
  }

  /**
   * Hebt eine Sperre sofort auf (Notfallkommando `emergency unlock`).
   * Die Kennung ist Nutzername ODER E-Mail. Gibt den Zustand vor der Aufhebung
   * zurück; wirft, wenn es die Kennung nicht gibt — im Terminal ist eine klare
   * Fehlermeldung nützlicher als eine neutrale Antwort.
   */
  async unlock(
    identifier: string,
    actor: string,
  ): Promise<{ wasLocked: boolean; failedAttemptsBefore: number }> {
    const cleaned = identifier.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ username: cleaned }, { email: cleaned }] },
      select: {
        id: true,
        username: true,
        email: true,
        failedAttempts: true,
        lockedUntil: true,
      },
    });
    if (!user) {
      throw new NotFoundException(
        `Es gibt kein Konto mit der Kennung "${identifier}".`,
      );
    }

    // Zustand VOR dem Zurücksetzen festhalten — danach steht er nicht mehr
    // zur Verfügung und der Audit-Eintrag bräuchte ihn.
    const wasLocked = this.remainingSeconds(user.lockedUntil) > 0;
    const failedAttemptsBefore = user.failedAttempts;

    await this.setBack(user.id);
    await this.audit.log({
      userId: user.id,
      actor,
      action: AUDIT_ACTION.accountUnlocked,
      objectType: 'User',
      objectId: user.id,
      beforeValue: { failedAttempts: failedAttemptsBefore, locked: wasLocked },
      afterValue: { failedAttempts: 0, locked: false },
      ip: null,
      userAgent: null,
    });

    return { wasLocked, failedAttemptsBefore };
  }
}
