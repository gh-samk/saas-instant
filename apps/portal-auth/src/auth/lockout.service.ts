import { Injectable } from '@nestjs/common';
import { LOCKOUT_DURATION_MS, MAX_FAILED_ATTEMPTS, lockoutRemainingSeconds } from '@saas-instant/auth-core';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma.service';

/** Zählt Fehlversuche je Konto in EINEM atomaren UPDATE (kein Lesen-dann-Schreiben). */
@Injectable()
export class LockoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  remainingSeconds(lockedUntil: Date | null, now: Date = new Date()): number {
    return lockoutRemainingSeconds(lockedUntil, now);
  }

  /**
   * Verbucht einen Fehlversuch; gibt die Restsekunden einer dadurch bestehenden
   * Sperre zurück (0 = nicht gesperrt). Eine abgelaufene Sperre setzt den
   * Zähler auf 1 zurück. Beide CASE-Zweige lesen die ALTEN Spaltenwerte.
   */
  async recordFailure(accountId: string, ip: string | null, now: Date = new Date()): Promise<number> {
    const lockoutEnd = new Date(now.getTime() + LOCKOUT_DURATION_MS);
    const rows = await this.prisma.$queryRaw<{ failedAttempts: number; lockedUntil: Date | null }[]>`
      UPDATE "Account"
      SET
        "failedAttempts" = CASE
          WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" <= (${now}::timestamptz AT TIME ZONE 'UTC') THEN 1
          ELSE "failedAttempts" + 1
        END,
        "lockedUntil" = CASE
          WHEN (CASE
                  WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" <= (${now}::timestamptz AT TIME ZONE 'UTC') THEN 1
                  ELSE "failedAttempts" + 1
                END) >= ${MAX_FAILED_ATTEMPTS}
            THEN (${lockoutEnd}::timestamptz AT TIME ZONE 'UTC')
          ELSE NULL
        END
      WHERE "id" = ${accountId}
      RETURNING "failedAttempts", "lockedUntil"
    `;
    const state = rows[0];
    if (!state) return 0;
    if (state.failedAttempts === MAX_FAILED_ATTEMPTS) {
      await this.audit.log({
        action: 'login.locked',
        accountId,
        ip,
        detail: { failedAttempts: state.failedAttempts, lockoutSeconds: LOCKOUT_DURATION_MS / 1000 },
      });
    }
    return this.remainingSeconds(state.lockedUntil, now);
  }

  async reset(accountId: string): Promise<void> {
    await this.prisma.account.update({
      where: { id: accountId },
      data: { failedAttempts: 0, lockedUntil: null },
    });
  }
}
