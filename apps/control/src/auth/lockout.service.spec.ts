import { AuditService } from '../audit/audit.service';
import { AccountLockedError } from '../common/errors/business-error';
import { buildUser, buildDouble } from '../test-support/prisma-double';
import { MAX_FAILED_ATTEMPTS, LOCKOUT_DURATION_MS, LockoutService } from './lockout.service';

const SOURCE = { ip: '203.0.113.7', userAgent: 'Jest' };

function build() {
  const user = buildUser();
  const { prisma, store: data } = buildDouble({ user: [user] });
  const audit = new AuditService(prisma);
  return { service: new LockoutService(prisma, audit), user, data };
}

describe('SperreService — selbstheilende Kontosperre', () => {
  it('sperrt genau ab dem fünften Fehlversuch', async () => {
    const { service, user, data } = build();
    const now = new Date('2026-08-29T10:00:00.000Z');

    for (let attempt = 1; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      const seconds = await service.recordFailedAttempt(
        data.user[0],
        SOURCE,
        now,
      );
      expect(seconds).toBe(0);
      expect(data.user[0].lockedUntil).toBeNull();
      expect(data.user[0].failedAttempts).toBe(attempt);
    }

    const seconds = await service.recordFailedAttempt(
      data.user[0],
      SOURCE,
      now,
    );
    expect(seconds).toBe(LOCKOUT_DURATION_MS / 1000);
    expect(data.user[0].failedAttempts).toBe(MAX_FAILED_ATTEMPTS);
    expect(data.user[0].lockedUntil).toEqual(
      new Date(now.getTime() + LOCKOUT_DURATION_MS),
    );
    expect(user.id).toBe(data.user[0].id);
  });

  it('wirft den Vertragsfehler konto_gesperrt mit Restsekunden', async () => {
    const { service, data } = build();
    const now = new Date('2026-08-29T10:00:00.000Z');
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await service.recordFailedAttempt(data.user[0], SOURCE, now);
    }

    // Fünf Minuten später: noch gesperrt, zehn Minuten Restzeit.
    const later = new Date(now.getTime() + 5 * 60 * 1000);
    let caught: unknown = null;
    try {
      service.checkNotLocked(data.user[0], later);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AccountLockedError);
    const error = caught as AccountLockedError;
    expect(error.getStatus()).toBe(429);
    expect(error.errorCode).toBe('account_locked');
    expect(error.errorDetail).toEqual({ secondsRemaining: 600 });
  });

  it('lässt die Sperre nach 15 Minuten von selbst enden', async () => {
    const { service, data } = build();
    const now = new Date('2026-08-29T10:00:00.000Z');
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await service.recordFailedAttempt(data.user[0], SOURCE, now);
    }

    const shortBeforeExpiry = new Date(now.getTime() + LOCKOUT_DURATION_MS - 1000);
    expect(() =>
      service.checkNotLocked(data.user[0], shortBeforeExpiry),
    ).toThrow(AccountLockedError);

    const afterExpiry = new Date(now.getTime() + LOCKOUT_DURATION_MS + 1);
    expect(() =>
      service.checkNotLocked(data.user[0], afterExpiry),
    ).not.toThrow();
    expect(service.remainingSeconds(data.user[0].lockedUntil, afterExpiry)).toBe(0);
  });

  it('zählt nach einer abgelaufenen Sperre wieder bei eins', async () => {
    const { service, data } = build();
    const now = new Date('2026-08-29T10:00:00.000Z');
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await service.recordFailedAttempt(data.user[0], SOURCE, now);
    }

    const afterExpiry = new Date(now.getTime() + LOCKOUT_DURATION_MS + 1000);
    const seconds = await service.recordFailedAttempt(
      data.user[0],
      SOURCE,
      afterExpiry,
    );
    expect(seconds).toBe(0);
    expect(data.user[0].failedAttempts).toBe(1);
    expect(data.user[0].lockedUntil).toBeNull();
  });

  it('protokolliert die Sperre im Audit-Log', async () => {
    const { service, data } = build();
    const now = new Date('2026-08-29T10:00:00.000Z');
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await service.recordFailedAttempt(data.user[0], SOURCE, now);
    }

    const entries = data.audit.filter(
      (line) => line.action === 'account.locked',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].ip).toBe('203.0.113.7');
    expect(entries[0].userAgent).toBe('Jest');
    expect(entries[0].actor).toBe('sam');
    expect(entries[0].beforeValue).toEqual({ failedAttempts: 4, locked: false });
    expect(entries[0].afterValue).toEqual({
      failedAttempts: 5,
      locked: true,
      lockoutDurationSeconds: 900,
    });
  });

  it('hebt die Sperre per Notfallkommando sofort auf und protokolliert das', async () => {
    const { service, data } = build();
    // Echte Uhrzeit: `entsperre` prüft gegen die laufende Uhr, nicht gegen
    // einen übergebenen Zeitpunkt.
    const now = new Date();
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await service.recordFailedAttempt(data.user[0], SOURCE, now);
    }

    const state = await service.unlock(
      data.user[0].username,
      'cli:testlauf',
    );
    expect(state.wasLocked).toBe(true);
    expect(state.failedAttemptsBefore).toBe(5);
    expect(data.user[0].lockedUntil).toBeNull();
    expect(data.user[0].failedAttempts).toBe(0);

    const entry = data.audit.find(
      (line) => line.action === 'account.unlocked',
    );
    expect(entry?.actor).toBe('cli:testlauf');
    expect(entry?.beforeValue).toEqual({ failedAttempts: 5, locked: true });
  });
});

describe('SperreService — Roh-SQL gegen das Schema', () => {
  it('verwendet nur Spalten, die es in der Tabelle User gibt', async () => {
    const user = buildUser();
    let sql = '';
    const prisma = {
      $queryRaw: async (parts: TemplateStringsArray) => {
        sql = parts.join('?');
        return [{ failedAttempts: 1, lockedUntil: null }];
      },
    };
    const service = new LockoutService(prisma as never, {} as never);
    await service.recordFailedAttempt(user, SOURCE);
    expect(sql).toContain('"failedAttempts"');
    expect(sql).toContain('"lockedUntil"');
    expect(sql).not.toMatch(/fehlversuche|gesperrtBis/);
  });
});
