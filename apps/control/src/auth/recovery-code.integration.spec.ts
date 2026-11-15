import { randomUUID } from 'crypto';
import { PrismaClient } from '.prisma/control-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  COUNT_CODES,
  RecoveryCodeService,
} from './recovery-code.service';

/**
 * Rennfestigkeit der Wiederherstellungscodes — gegen eine ECHTE Datenbank.
 *
 * Dieser Lauf fehlte als einziger noch ([H4]): Sperrzähler, Codeeinlösung und
 * Faktorentfernung hatten ihn längst. Der Unit-Test dazu prüft dasselbe gegen
 * die In-Memory-Attrappe und kann die Atomarität grundsätzlich nicht belegen —
 * JavaScript ist einfädig, dort entsteht kein Rennen.
 *
 * Wiederherstellungscodes sind die letzte Rückfallebene, wenn Postfach und
 * Authenticator weg sind. Ein Code, der sich zweimal einlösen lässt, wäre
 * genau dort ein Fehler.
 *
 * Voraussetzung:
 *   docker compose --profile control up -d control-db
 *   DATABASE_URL=… pnpm test:integration
 */

// argon2 ist absichtlich langsam; acht Hashes je Konto brauchen Zeit.
jest.setTimeout(120_000);

const prisma = new PrismaClient() as unknown as PrismaService;
const service = new RecoveryCodeService(prisma);

async function newAccount(): Promise<string> {
  const identifier = `wcode-${randomUUID().slice(0, 8)}`;
  const user = await prisma.user.create({
    data: {
      name: 'Wiederherstellung',
      username: identifier,
      email: `${identifier}@example.com`,
    },
    select: { id: true },
  });
  return user.id;
}

afterAll(async () => {
  await prisma.user.deleteMany({
    where: { username: { startsWith: 'wcode-' } },
  });
  await (prisma as unknown as PrismaClient).$disconnect();
});

describe('Wiederherstellungscodes gegen echte Datenbank', () => {
  it('lässt bei ZWEI GLEICHZEITIGEN Einlösungen desselben Codes genau eine gelten', async () => {
    const userId = await newAccount();
    const codes = await service.generateNewCodes(userId);

    const results = await Promise.all([
      service.resolve(userId, codes[0]),
      service.resolve(userId, codes[0]),
    ]);

    expect(results.filter((e) => e !== null)).toHaveLength(1);
    expect(await service.countOpen(userId)).toBe(COUNT_CODES - 1);
  });

  it('lässt auch bei zehn gleichzeitigen Einlösungen genau eine gelten', async () => {
    const userId = await newAccount();
    const codes = await service.generateNewCodes(userId);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => service.resolve(userId, codes[0])),
    );

    expect(results.filter((e) => e !== null)).toHaveLength(1);
    expect(await service.countOpen(userId)).toBe(COUNT_CODES - 1);
  });

  it('verbraucht bei acht gleichzeitigen Einlösungen VERSCHIEDENER Codes genau acht', async () => {
    // Gegenprobe: die Sperre darf nicht mehr verhindern als das Doppelte
    // desselben Codes.
    const userId = await newAccount();
    const codes = await service.generateNewCodes(userId);

    const results = await Promise.all(
      codes.map((code) => service.resolve(userId, code)),
    );

    expect(results.filter((e) => e !== null)).toHaveLength(COUNT_CODES);
    expect(await service.countOpen(userId)).toBe(0);
  });

  it('erzeugt bei gleichzeitigem Neuerzeugen niemals mehr als acht offene Codes', async () => {
    const userId = await newAccount();

    await Promise.all([
      service.generateNewCodes(userId),
      service.generateNewCodes(userId),
    ]);

    expect(await service.countOpen(userId)).toBe(COUNT_CODES);
  });

  it('speichert nirgends den Klartext', async () => {
    const userId = await newAccount();
    const codes = await service.generateNewCodes(userId);

    const lines = await prisma.recoveryCode.findMany({
      where: { userId },
    });
    const everything = JSON.stringify(lines);
    for (const code of codes) {
      expect(everything).not.toContain(code);
    }
  });
});
