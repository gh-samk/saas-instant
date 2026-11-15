import { randomUUID } from 'crypto';
import { PrismaClient } from '.prisma/control-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  CODE_MAX_FAILED_ATTEMPTS,
  EmailLoginCodeService,
} from './email-login-code.service';

/**
 * Rennfestigkeit des E-Mail-Anmeldecodes — gegen eine ECHTE Postgres-Datenbank.
 *
 * Mit der In-Memory-Attrappe ist der Nachweis nicht zu führen: JavaScript ist
 * einfädig, dort kann gar kein Rennen entstehen. Geprüft werden dieselben
 * beiden Stellen wie bei den Wiederherstellungscodes und beim Sperrzähler:
 *
 * - das bedingte `updateMany` mit `verbrauchtAm: null` (Einmaligkeit)
 * - das `increment` auf `fehlversuche` (Zähler lässt sich nicht bündeln)
 *
 * Voraussetzung:
 *   docker compose --profile control up -d control-db
 *   DATABASE_URL=postgresql://…:5434/saas_instant_control pnpm test:integration
 */

// argon2 ist absichtlich langsam; parallele Einlösungen brauchen Zeit.
jest.setTimeout(60_000);

const prisma = new PrismaClient() as unknown as PrismaService;
const service = new EmailLoginCodeService(prisma);

/** Legt ein frisches Testkonto an. */
async function newAccount(): Promise<string> {
  const identifier = `code-${randomUUID().slice(0, 8)}`;
  const user = await prisma.user.create({
    data: {
      name: 'Codeprüfung',
      username: identifier,
      email: `${identifier}@example.com`,
      loginCodeEnabled: true,
    },
    select: { id: true },
  });
  return user.id;
}

/** Fordert einen Code an und gibt den Klartext zurück. */
async function request(userId: string): Promise<string> {
  const result = await service.request(
    userId,
    'ziel@example.com',
    false,
  );
  if (result.kind !== 'generated') {
    throw new Error(`Erwartet: erzeugt, bekommen: ${result.kind}`);
  }
  return result.code;
}

afterAll(async () => {
  await prisma.user.deleteMany({
    where: { username: { startsWith: 'code-' } },
  });
  await (prisma as unknown as PrismaClient).$disconnect();
});

describe('E-Mail-Anmeldecode gegen echte Datenbank', () => {
  it('lässt bei ZWEI GLEICHZEITIGEN Einlösungen genau eine gelten', async () => {
    const userId = await newAccount();
    const code = await request(userId);

    const [a, b] = await Promise.all([
      service.resolve(userId, code, false),
      service.resolve(userId, code, false),
    ]);

    expect([a.kind, b.kind].filter((kind) => kind === 'ok')).toHaveLength(1);
  });

  it('lässt auch bei zehn gleichzeitigen Einlösungen genau eine gelten', async () => {
    const userId = await newAccount();
    const code = await request(userId);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        service.resolve(userId, code, false),
      ),
    );

    expect(results.filter((e) => e.kind === 'ok')).toHaveLength(1);
  });

  it('zählt GLEICHZEITIGE Fehlversuche einzeln und verbrennt den Code', async () => {
    // Der Kern: würde der Zähler aus einem vorher gelesenen Wert fortgeschrieben,
    // stünde am Ende 1 statt 5 und ein Angreifer könnte beliebig weiterraten,
    // indem er seine Versuche bündelt.
    const userId = await newAccount();
    const code = await request(userId);

    await Promise.all(
      Array.from({ length: CODE_MAX_FAILED_ATTEMPTS }, () =>
        service.resolve(userId, '00000000', false),
      ),
    );

    const line = await prisma.emailLoginCode.findFirstOrThrow({
      where: { userId },
      select: { failedAttempts: true },
    });
    expect(line.failedAttempts).toBe(CODE_MAX_FAILED_ATTEMPTS);

    // Und damit ist der richtige Code wertlos — und sagt das auch ([H1]).
    expect((await service.resolve(userId, code, false)).kind).toBe(
      'burned',
    );
  });

  it('zählt auch zwanzig gleichzeitige Fehlversuche jeden einzeln', async () => {
    const userId = await newAccount();
    await request(userId);

    await Promise.all(
      Array.from({ length: 20 }, () =>
        service.resolve(userId, '00000000', false),
      ),
    );

    const line = await prisma.emailLoginCode.findFirstOrThrow({
      where: { userId },
      select: { failedAttempts: true },
    });
    expect(line.failedAttempts).toBe(20);
  });

  it('[W2] lässt von FÜNF GLEICHZEITIGEN Anforderungen genau eine durch', async () => {
    // Vorher: fünf Anforderungen ergaben fünf Codes und fünf Mails, von denen
    // vier schon tot ankamen, weil jede die vorige entwertete. Der echte
    // Benutzer tippte dann einen gültig aussehenden Code ein und bekam einen
    // Fehlversuch angerechnet.
    const userId = await newAccount();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.request(userId, 'ziel@example.com', false),
      ),
    );

    const generated = results.filter((e) => e.kind === 'generated');
    expect(generated).toHaveLength(1);
    expect(results.filter((e) => e.kind === 'too_early')).toHaveLength(4);

    // Und der EINE ausgegebene Code ist auch der, der in der Datenbank steht.
    const valid = generated[0];
    if (valid.kind !== 'generated') throw new Error('unerwartet');
    expect((await service.resolve(userId, valid.code, false)).kind).toBe(
      'ok',
    );
  });

  it('[W2] lässt auch von zwanzig gleichzeitigen Anforderungen genau eine durch', async () => {
    const userId = await newAccount();

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.request(userId, 'ziel@example.com', false),
      ),
    );

    expect(results.filter((e) => e.kind === 'generated')).toHaveLength(1);
    expect(await prisma.emailLoginCode.count({ where: { userId } })).toBe(1);
  });

  it('[H2] lässt nach erfolgreicher Anmeldung sofort einen neuen Code zu', async () => {
    // Vorher blockierte ein VERBRAUCHTER Code die Neuanforderung bis zu 60
    // Sekunden, ohne dass es jemand sagte.
    const userId = await newAccount();
    const code = await request(userId);
    expect((await service.resolve(userId, code, false)).kind).toBe('ok');

    const immediately = await service.request(
      userId,
      'ziel@example.com',
      false,
    );

    expect(immediately.kind).toBe('generated');
  });

  it('[H2] hält den VERBRANNTEN Code dagegen weiter als Sperre', async () => {
    const userId = await newAccount();
    await request(userId);
    for (let attempt = 0; attempt < CODE_MAX_FAILED_ATTEMPTS; attempt += 1) {
      await service.resolve(userId, '00000000', false);
    }

    const resupply = await service.request(
      userId,
      'ziel@example.com',
      false,
    );

    expect(resupply.kind).toBe('too_early');
  });

  it('[H3] lässt die Datenbank keinen zweiten Code je Benutzer zu', async () => {
    // Die Invariante ist eine EIGENSCHAFT, kein Versprechen des Codes.
    const userId = await newAccount();
    await request(userId);

    await expect(
      prisma.emailLoginCode.create({
        data: {
          userId,
          codeHash: 'egal',
          targetEmail: 'zweit@example.com',
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('hinterlässt je Benutzer immer HÖCHSTENS EINEN Code', async () => {
    const userId = await newAccount();
    const start = new Date('2026-08-30T09:00:00Z');

    // Drei Anforderungen mit jeweils mehr als 60 Sekunden Abstand.
    for (let round = 0; round < 3; round += 1) {
      const result = await service.request(
        userId,
        'ziel@example.com',
        false,
        new Date(start.getTime() + round * 120_000),
      );
      expect(result.kind).toBe('generated');
    }

    expect(await prisma.emailLoginCode.count({ where: { userId } })).toBe(1);
  });

  it('speichert nirgends den Klartext des Codes', async () => {
    const userId = await newAccount();
    const code = await request(userId);

    const line = await prisma.emailLoginCode.findFirstOrThrow({
      where: { userId },
    });
    expect(JSON.stringify(line)).not.toContain(code);
    expect(line.codeHash.startsWith('$argon2id$')).toBe(true);
  });

  it('löscht die Codes mit dem Konto (Cascade)', async () => {
    const userId = await newAccount();
    await request(userId);

    await prisma.user.delete({ where: { id: userId } });

    expect(await prisma.emailLoginCode.count({ where: { userId } })).toBe(0);
  });
});
