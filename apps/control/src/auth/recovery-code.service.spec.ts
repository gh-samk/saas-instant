import { buildUser, buildDouble } from '../test-support/prisma-double';
import {
  COUNT_CODES,
  normalizeCode,
  RecoveryCodeService,
} from './recovery-code.service';

// argon2 ist absichtlich langsam; acht Hashes brauchen mehr als die Vorgabe.
jest.setTimeout(30_000);

function build() {
  const user = buildUser();
  const { prisma, store: data } = buildDouble({ user: [user] });
  return {
    service: new RecoveryCodeService(prisma),
    user,
    data,
  };
}

describe('RecoveryCodeService', () => {
  it('erzeugt genau acht Codes und speichert nur Hashes', async () => {
    const { service, user, data } = build();
    const codes = await service.generateNewCodes(user.id);

    expect(codes).toHaveLength(COUNT_CODES);
    expect(data.codes).toHaveLength(COUNT_CODES);

    // Kein Klartext in der Ablage.
    const stored = data.codes.map((line) => line.codeHash).join('|');
    for (const code of codes) {
      expect(stored).not.toContain(code);
      expect(stored).not.toContain(normalizeCode(code));
    }
    for (const line of data.codes) {
      expect(line.codeHash.startsWith('$argon2id$')).toBe(true);
    }
  });

  it('löst einen Code genau EINMAL ein — der zweite Versuch scheitert', async () => {
    const { service, user } = build();
    const codes = await service.generateNewCodes(user.id);

    const firstAttempt = await service.resolve(user.id, codes[0]);
    expect(firstAttempt).not.toBeNull();

    const secondAttempt = await service.resolve(user.id, codes[0]);
    expect(secondAttempt).toBeNull();

    expect(await service.countOpen(user.id)).toBe(COUNT_CODES - 1);
  });

  it('erkennt Codes unabhängig von Schreibweise und Trennern', async () => {
    const { service, user } = build();
    const codes = await service.generateNewCodes(user.id);
    const other = codes[0].toUpperCase().replace('-', ' ');

    expect(await service.resolve(user.id, other)).not.toBeNull();
  });

  it('lässt bei zwei gleichzeitigen Einlösungen desselben Codes nur eine gelten', async () => {
    const { service, user } = build();
    const codes = await service.generateNewCodes(user.id);

    const [a, b] = await Promise.all([
      service.resolve(user.id, codes[0]),
      service.resolve(user.id, codes[0]),
    ]);

    const successful = [a, b].filter((value) => value !== null);
    expect(successful).toHaveLength(1);
    expect(await service.countOpen(user.id)).toBe(COUNT_CODES - 1);
  });

  it('weist falsche und leere Codes ab, ohne einen gültigen zu verbrauchen', async () => {
    const { service, user } = build();
    await service.generateNewCodes(user.id);

    expect(await service.resolve(user.id, 'zzzz-zzzz')).toBeNull();
    expect(await service.resolve(user.id, '')).toBeNull();
    expect(await service.resolve(user.id, '!!!!')).toBeNull();
    expect(await service.countOpen(user.id)).toBe(COUNT_CODES);
  });

  it('verwirft beim Neuerzeugen alle bisherigen Codes', async () => {
    const { service, user } = build();
    const old = await service.generateNewCodes(user.id);
    await service.generateNewCodes(user.id);

    expect(await service.countOpen(user.id)).toBe(COUNT_CODES);
    expect(await service.resolve(user.id, old[0])).toBeNull();
  });
});
