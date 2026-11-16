/** Ab dem fünften Fehlversuch wird gesperrt. */
export const MAX_FAILED_ATTEMPTS = 5;
/**
 * Dauer der Sperre: 15 Minuten. Die Sperre endet von selbst — sonst wäre sie
 * bei einem bekannten Konto ein Denial-of-Service.
 */
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

/** Zähler und Sperre eines Kontos. */
export interface LockoutCounters {
  failedAttempts: number;
  lockedUntil: Date | null;
}

/**
 * Restsekunden der Sperre, oder 0 wenn nicht (mehr) gesperrt. Bewusst
 * aufgerundet: „noch 0 Sekunden" wäre irreführend.
 */
export function lockoutRemainingSeconds(
  lockedUntil: Date | null,
  now: Date = new Date(),
): number {
  if (!lockedUntil) return 0;
  const remaining = lockedUntil.getTime() - now.getTime();
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

/** Ende einer Sperre, die jetzt beginnt. */
export function lockoutEnd(now: Date = new Date()): Date {
  return new Date(now.getTime() + LOCKOUT_DURATION_MS);
}

/**
 * Zustand nach einem Fehlversuch — die Rechenregel, die auch das atomare
 * SQL-UPDATE der Verwaltung umsetzt:
 *
 * - Eine abgelaufene Sperre setzt den Zähler zurück auf 1 (ein Fehlversuch von
 *   vor Wochen zählt nicht mit).
 * - Sonst wächst der Zähler um 1.
 * - Ab `MAX_FAILED_ATTEMPTS` wird für `LOCKOUT_DURATION_MS` gesperrt, sonst
 *   steht keine Sperre.
 *
 * ACHTUNG Nebenläufigkeit: Wer diese Funktion auf einem vorher gelesenen
 * Snapshot ausführt, verliert gebündelte Anfragen. Gleichzeitige Versuche
 * gehören in EIN bedingtes UPDATE der Datenbank; die Funktion ist für
 * Speicher ohne solche Möglichkeit und für Tests der Regel.
 */
export function nextAfterFailedAttempt(
  state: LockoutCounters,
  now: Date = new Date(),
): LockoutCounters {
  const expired =
    state.lockedUntil !== null &&
    state.lockedUntil.getTime() <= now.getTime();
  const failedAttempts = expired ? 1 : state.failedAttempts + 1;
  return {
    failedAttempts,
    lockedUntil:
      failedAttempts >= MAX_FAILED_ATTEMPTS ? lockoutEnd(now) : null,
  };
}
