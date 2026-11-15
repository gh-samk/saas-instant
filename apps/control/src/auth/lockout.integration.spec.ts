import { randomUUID } from 'crypto';
import { PrismaClient } from '.prisma/control-client';
import { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { MAX_FAILED_ATTEMPTS, LOCKOUT_DURATION_MS, LockoutService } from './lockout.service';
import type { LockoutState } from './lockout.service';

/**
 * Rennfestigkeit der Kontosperre — gegen eine ECHTE Postgres-Datenbank.
 *
 * Mit einer In-Memory-Attrappe ist dieser Nachweis nicht zu führen:
 * JavaScript ist einfädig, dort kann gar kein Rennen entstehen. Der Befund
 * [K1] wurde ebenfalls an der laufenden Anwendung gemessen, nicht gelesen.
 *
 * Voraussetzung:
 *   docker compose --profile control up -d control-db
 *   DATABASE_URL=postgresql://…:5434/saas_instant_control pnpm test:integration
 */

const SOURCE = { ip: '203.0.113.42', userAgent: 'Jest-Integration' };

const prisma = new PrismaClient() as unknown as PrismaService;
const audit = new AuditService(prisma);
const service = new LockoutService(prisma, audit);

/** Legt ein frisches Testkonto an und liefert seinen Sperrstand. */
async function newAccount(): Promise<LockoutState> {
  const identifier = `renn-${randomUUID().slice(0, 8)}`;
  const user = await prisma.user.create({
    data: {
      name: 'Rennfestigkeit',
      username: identifier,
      email: `${identifier}@example.com`,
    },
    select: {
      id: true,
      username: true,
      email: true,
      failedAttempts: true,
      lockedUntil: true,
    },
  });
  return user;
}

async function stateOf(id: string) {
  const line = await prisma.user.findUniqueOrThrow({
    where: { id },
    select: { failedAttempts: true, lockedUntil: true },
  });
  return line;
}

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { actor: { startsWith: 'renn-' } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: 'renn-' } } });
  await (prisma as unknown as PrismaClient).$disconnect();
});

describe('Kontosperre gegen echte Datenbank', () => {
  it('zählt sequenziell korrekt hoch und sperrt beim fünften Versuch', async () => {
    const account = await newAccount();

    for (let attempt = 1; attempt <= MAX_FAILED_ATTEMPTS; attempt += 1) {
      await service.recordFailedAttempt(account, SOURCE);
      const state = await stateOf(account.id);
      expect(state.failedAttempts).toBe(attempt);
      if (attempt < MAX_FAILED_ATTEMPTS) {
        expect(state.lockedUntil).toBeNull();
      } else {
        expect(state.lockedUntil).not.toBeNull();
      }
    }
  });

  it('hält auch bei FÜNF GLEICHZEITIGEN Versuchen — das ist der Kern von [K1]', async () => {
    const account = await newAccount();

    // Genau der gemessene Angriff: Rateversuche gebündelt statt nacheinander.
    // Vorher schrieben alle denselben Absolutwert 1 und das Konto blieb offen.
    await Promise.all(
      Array.from({ length: MAX_FAILED_ATTEMPTS }, () =>
        service.recordFailedAttempt(account, SOURCE),
      ),
    );

    const state = await stateOf(account.id);
    expect(state.failedAttempts).toBe(MAX_FAILED_ATTEMPTS);
    expect(state.lockedUntil).not.toBeNull();
    expect(service.remainingSeconds(state.lockedUntil)).toBeGreaterThan(0);
  });

  it('zählt auch bei zwanzig gleichzeitigen Versuchen jeden einzeln', async () => {
    const account = await newAccount();

    await Promise.all(
      Array.from({ length: 20 }, () =>
        service.recordFailedAttempt(account, SOURCE),
      ),
    );

    const state = await stateOf(account.id);
    expect(state.failedAttempts).toBe(20);
    expect(state.lockedUntil).not.toBeNull();
  });

  it('schreibt trotz Parallelität GENAU EINEN Sperr-Eintrag ins Audit-Log', async () => {
    const account = await newAccount();

    await Promise.all(
      Array.from({ length: 12 }, () =>
        service.recordFailedAttempt(account, SOURCE),
      ),
    );

    const entries = await prisma.auditLog.count({
      where: { userId: account.id, action: 'account.locked' },
    });
    expect(entries).toBe(1);
  });

  it('setzt den Zähler nach abgelaufener Sperre auf eins zurück', async () => {
    const account = await newAccount();
    const earlier = new Date(Date.now() - 2 * LOCKOUT_DURATION_MS);

    // Sperre in der Vergangenheit auslösen …
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await service.recordFailedAttempt(account, SOURCE, earlier);
    }
    const locked = await stateOf(account.id);
    expect(locked.lockedUntil).not.toBeNull();
    expect(service.remainingSeconds(locked.lockedUntil)).toBe(0);

    // … ein neuer Versuch jetzt beginnt wieder bei eins.
    await service.recordFailedAttempt(account, SOURCE);
    const afterwards = await stateOf(account.id);
    expect(afterwards.failedAttempts).toBe(1);
    expect(afterwards.lockedUntil).toBeNull();
  });

  it('[H4] rechnet die Sperrdauer unabhängig von der Zeitzone der DB-Sitzung', async () => {
    // Ein blosses `::timestamp` würde den Parameter in die Sitzungs-Zeitzone
    // umrechnen. Mit TZ=Europe/Berlin läge die Sperre dann zwei Stunden daneben.
    await prisma.$executeRawUnsafe("SET TIME ZONE 'Europe/Berlin'");
    try {
      const account = await newAccount();
      const now = new Date();

      for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
        await service.recordFailedAttempt(account, SOURCE, now);
      }

      const state = await stateOf(account.id);
      expect(state.lockedUntil).not.toBeNull();

      // Die Sperre endet in ~15 Minuten, nicht in 15 Minuten ± 2 Stunden.
      const remainingSeconds = service.remainingSeconds(state.lockedUntil, now);
      expect(remainingSeconds).toBeGreaterThan(LOCKOUT_DURATION_MS / 1000 - 5);
      expect(remainingSeconds).toBeLessThanOrEqual(LOCKOUT_DURATION_MS / 1000);
    } finally {
      await prisma.$executeRawUnsafe("SET TIME ZONE 'UTC'");
    }
  });

  it('[H4] erkennt eine abgelaufene Sperre auch bei fremder Sitzungs-Zeitzone', async () => {
    await prisma.$executeRawUnsafe("SET TIME ZONE 'Pacific/Kiritimati'");
    try {
      const account = await newAccount();
      const earlier = new Date(Date.now() - 2 * LOCKOUT_DURATION_MS);
      for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
        await service.recordFailedAttempt(account, SOURCE, earlier);
      }

      // Die Sperre von vor 30 Minuten ist abgelaufen: der Zähler beginnt neu.
      await service.recordFailedAttempt(account, SOURCE);
      const state = await stateOf(account.id);
      expect(state.failedAttempts).toBe(1);
      expect(state.lockedUntil).toBeNull();
    } finally {
      await prisma.$executeRawUnsafe("SET TIME ZONE 'UTC'");
    }
  });

  it('hebt die Sperre per Notfallkommando sofort auf', async () => {
    const account = await newAccount();
    await Promise.all(
      Array.from({ length: MAX_FAILED_ATTEMPTS }, () =>
        service.recordFailedAttempt(account, SOURCE),
      ),
    );

    const state = await service.unlock(account.username, 'cli:integration');
    expect(state.wasLocked).toBe(true);

    const afterwards = await stateOf(account.id);
    expect(afterwards.failedAttempts).toBe(0);
    expect(afterwards.lockedUntil).toBeNull();
  });
});
