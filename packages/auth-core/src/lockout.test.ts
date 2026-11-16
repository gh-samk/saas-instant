import { describe, expect, it } from 'vitest';
import {
  LOCKOUT_DURATION_MS,
  lockoutRemainingSeconds,
  MAX_FAILED_ATTEMPTS,
  nextAfterFailedAttempt,
} from './lockout';

const now = new Date('2026-01-01T10:00:00Z');

describe('lockout', () => {
  it('Restsekunden: aufgerundet, 0 ohne oder nach Ablauf', () => {
    expect(lockoutRemainingSeconds(null, now)).toBe(0);
    expect(lockoutRemainingSeconds(new Date(now.getTime() - 1), now)).toBe(0);
    expect(lockoutRemainingSeconds(new Date(now.getTime() + 1), now)).toBe(1);
    expect(lockoutRemainingSeconds(new Date(now.getTime() + 1500), now)).toBe(2);
  });

  it('sperrt erst ab dem fünften Fehlversuch, 15 Minuten', () => {
    let state = { failedAttempts: 0, lockedUntil: null as Date | null };
    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i += 1) {
      state = nextAfterFailedAttempt(state, now);
      expect(state.failedAttempts).toBe(i);
      expect(state.lockedUntil).toBeNull();
    }
    state = nextAfterFailedAttempt(state, now);
    expect(state.failedAttempts).toBe(MAX_FAILED_ATTEMPTS);
    expect(state.lockedUntil?.getTime()).toBe(now.getTime() + LOCKOUT_DURATION_MS);
  });

  it('abgelaufene Sperre setzt den Zähler auf 1 zurück', () => {
    const state = nextAfterFailedAttempt(
      { failedAttempts: 5, lockedUntil: new Date(now.getTime() - 1000) },
      now,
    );
    expect(state).toEqual({ failedAttempts: 1, lockedUntil: null });
  });
});
