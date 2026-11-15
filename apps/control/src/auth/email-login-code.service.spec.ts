import { buildUser, buildDouble } from '../test-support/prisma-double';
import {
  CODE_AGAIN_BY_MS,
  CODE_VALID_MS,
  CODE_LENGTH,
  CODE_MAX_FAILED_ATTEMPTS,
  EmailLoginCodeService,
  generateCode,
  normalizeDigitCode,
} from './email-login-code.service';

// argon2 ist absichtlich langsam; Hashen und Prüfen brauchen mehr als die Vorgabe.
jest.setTimeout(30_000);

const TARGET = 'inhaber@example.com';

function build() {
  const user = buildUser({ loginCodeEnabled: true });
  const { prisma, store: data } = buildDouble({ user: [user] });
  return { service: new EmailLoginCodeService(prisma), user, data };
}

/** Fordert einen Code an und gibt den Klartext zurück; wirft, wenn zu früh. */
async function request(
  service: EmailLoginCodeService,
  userId: string,
  now?: Date,
): Promise<string> {
  const result = await service.request(userId, TARGET, false, now);
  if (result.kind !== 'generated') {
    throw new Error(`Erwartet: erzeugt, bekommen: ${result.kind}`);
  }
  return result.code;
}

describe('E-Mail-Anmeldecode — Form und Zufall', () => {
  it('erzeugt genau acht Ziffern', () => {
    for (let run = 0; run < 200; run += 1) {
      const code = generateCode();
      expect(code).toHaveLength(CODE_LENGTH);
      expect(code).toMatch(/^\d{8}$/);
    }
  });

  it('erzeugt keine wiederkehrenden Codes', () => {
    // 500 Ziehungen aus 10^8 Möglichkeiten: eine Kollision wäre nach dem
    // Geburtstagsproblem in rund einem von 800 Läufen zu erwarten. Ein
    // FESTER Generator (etwa eine hochzählende Zahl) fiele hier sofort auf.
    const seen = new Set<string>();
    for (let run = 0; run < 500; run += 1) {
      seen.add(generateCode());
    }
    expect(seen.size).toBe(500);
  });

  it('nutzt alle zehn Ziffern an jeder Stelle', () => {
    // Wäre eine Stelle konstant oder nur teilweise besetzt, wäre der Suchraum
    // kleiner als angenommen. 2000 Ziehungen decken jede Stelle sicher ab.
    const perPlace: Set<string>[] = Array.from(
      { length: CODE_LENGTH },
      () => new Set<string>(),
    );
    for (let run = 0; run < 2000; run += 1) {
      const code = generateCode();
      for (let place = 0; place < CODE_LENGTH; place += 1) {
        perPlace[place].add(code[place]);
      }
    }
    for (const digits of perPlace) {
      expect(digits.size).toBe(10);
    }
  });

  it('erkennt Codes unabhängig von Leerzeichen und Trennern', () => {
    expect(normalizeDigitCode('1234 5678')).toBe('12345678');
    expect(normalizeDigitCode('1234-5678')).toBe('12345678');
  });
});

describe('E-Mail-Anmeldecode — Anfordern', () => {
  it('speichert nur den Hash, niemals den Klartext', async () => {
    const { service, user, data } = build();
    const code = await request(service, user.id);

    expect(data.emailCodes).toHaveLength(1);
    expect(data.emailCodes[0].codeHash).not.toContain(code);
    expect(data.emailCodes[0].codeHash.startsWith('$argon2id$')).toBe(true);
    expect(JSON.stringify(data.emailCodes)).not.toContain(code);
  });

  it('weist ein erneutes Anfordern innerhalb von 60 Sekunden ab', async () => {
    const { service, user } = build();
    const start = new Date('2026-08-30T10:00:00Z');
    await request(service, user.id, start);

    const tooEarly = await service.request(
      user.id,
      TARGET,
      false,
      new Date(start.getTime() + CODE_AGAIN_BY_MS - 1000),
    );

    expect(tooEarly.kind).toBe('too_early');
    if (tooEarly.kind === 'too_early') {
      expect(tooEarly.secondsRemaining).toBe(1);
    }
  });

  it('lässt ein erneutes Anfordern nach 60 Sekunden zu', async () => {
    const { service, user } = build();
    const start = new Date('2026-08-30T10:00:00Z');
    await request(service, user.id, start);

    const later = await service.request(
      user.id,
      TARGET,
      false,
      new Date(start.getTime() + CODE_AGAIN_BY_MS),
    );

    expect(later.kind).toBe('generated');
  });

  it('lässt der 60-Sekunden-Sperre den ALTEN Code gültig', async () => {
    const { service, user, data } = build();
    const start = new Date('2026-08-30T10:00:00Z');
    const old = await request(service, user.id, start);

    await service.request(
      user.id,
      TARGET,
      false,
      new Date(start.getTime() + 5_000),
    );

    expect(data.emailCodes).toHaveLength(1);
    const result = await service.resolve(
      user.id,
      old,
      false,
      new Date(start.getTime() + 6_000),
    );
    expect(result.kind).toBe('ok');
  });

  it('entwertet mit einem neuen Code den alten', async () => {
    const { service, user, data } = build();
    const start = new Date('2026-08-30T10:00:00Z');
    const old = await request(service, user.id, start);
    const later = new Date(start.getTime() + CODE_AGAIN_BY_MS);
    const fresh = await request(service, user.id, later);

    expect(fresh).not.toBe(old);
    // Es gibt IMMER nur einen Datensatz — der alte ist restlos weg.
    expect(data.emailCodes).toHaveLength(1);

    const withOld = await service.resolve(user.id, old, false, later);
    expect(withOld.kind).toBe('wrong');

    const withNew = await service.resolve(user.id, fresh, false, later);
    expect(withNew.kind).toBe('ok');
  });
});

describe('E-Mail-Anmeldecode — Einlösen', () => {
  it('nimmt den richtigen Code an', async () => {
    const { service, user } = build();
    const code = await request(service, user.id);

    const result = await service.resolve(user.id, code, false);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.targetEmail).toBe(TARGET);
  });

  it('nimmt den Code auch mit Trennzeichen an', async () => {
    const { service, user } = build();
    const code = await request(service, user.id);
    const other = `${code.slice(0, 4)} ${code.slice(4)}`;

    expect((await service.resolve(user.id, other, false)).kind).toBe('ok');
  });

  it('gilt genau EINMAL — der zweite Versuch scheitert', async () => {
    const { service, user } = build();
    const code = await request(service, user.id);

    expect((await service.resolve(user.id, code, false)).kind).toBe('ok');
    expect((await service.resolve(user.id, code, false)).kind).toBe(
      'no_code',
    );
  });

  it('lässt bei zwei gleichzeitigen Einlösungen nur eine gelten', async () => {
    // Vollwertig belegt ist die Rennfestigkeit erst gegen eine echte Datenbank
    // (email-anmeldecode.integration.spec.ts) — JavaScript ist einfädig.
    const { service, user } = build();
    const code = await request(service, user.id);

    const [a, b] = await Promise.all([
      service.resolve(user.id, code, false),
      service.resolve(user.id, code, false),
    ]);

    expect([a.kind, b.kind].filter((kind) => kind === 'ok')).toHaveLength(1);
  });

  it('weist einen abgelaufenen Code ab', async () => {
    const { service, user } = build();
    const start = new Date('2026-08-30T10:00:00Z');
    const code = await request(service, user.id, start);

    const result = await service.resolve(
      user.id,
      code,
      false,
      new Date(start.getTime() + CODE_VALID_MS),
    );

    expect(result.kind).toBe('expired');
  });

  it('nimmt den Code eine Sekunde vor Ablauf noch an', async () => {
    const { service, user } = build();
    const start = new Date('2026-08-30T10:00:00Z');
    const code = await request(service, user.id, start);

    const result = await service.resolve(
      user.id,
      code,
      false,
      new Date(start.getTime() + CODE_VALID_MS - 1000),
    );

    expect(result.kind).toBe('ok');
  });

  it('zählt jeden Fehlversuch hoch und verbrennt den Code beim fünften', async () => {
    const { service, user, data } = build();
    await request(service, user.id);

    for (let attempt = 1; attempt <= CODE_MAX_FAILED_ATTEMPTS; attempt += 1) {
      const result = await service.resolve(user.id, '00000000', false);
      expect(result.kind).toBe('wrong');
      if (result.kind === 'wrong') {
        expect(result.failedAttempts).toBe(attempt);
        expect(result.burned).toBe(attempt === CODE_MAX_FAILED_ATTEMPTS);
      }
      expect(data.emailCodes[0].failedAttempts).toBe(attempt);
    }
  });

  it('nimmt einen verbrannten Code auch dann nicht mehr an, wenn er richtig ist', async () => {
    const { service, user } = build();
    const code = await request(service, user.id);

    for (let attempt = 0; attempt < CODE_MAX_FAILED_ATTEMPTS; attempt += 1) {
      await service.resolve(user.id, '00000000', false);
    }

    // Das ist der Kern: der richtige Code nützt jetzt nichts mehr. Und der
    // Zustand wird BENANNT, nicht als „kein Code" verschwiegen ([H1]).
    expect((await service.resolve(user.id, code, false)).kind).toBe(
      'burned',
    );
  });

  it('lässt einen verbrannten Code als Anker der 60-Sekunden-Sperre stehen', async () => {
    // Sonst könnte ein Angreifer nach je CODE_MAX_FEHLVERSUCHE Fehlversuchen
    // sofort einen frischen Code anfordern und beliebig weiterraten.
    const { service, user } = build();
    const start = new Date('2026-08-30T10:00:00Z');
    await request(service, user.id, start);
    for (let attempt = 0; attempt < CODE_MAX_FAILED_ATTEMPTS; attempt += 1) {
      await service.resolve(user.id, '00000000', false, start);
    }

    const resupply = await service.request(
      user.id,
      TARGET,
      false,
      new Date(start.getTime() + 10_000),
    );

    expect(resupply.kind).toBe('too_early');
  });

  it('weist einen Code mit falscher Stellenzahl ab, ohne zu hashen', async () => {
    const { service, user } = build();
    await request(service, user.id);

    const result = await service.resolve(user.id, '1234', false);

    expect(result.kind).toBe('wrong');
  });

  it('meldet „kein_code", wenn nie einer angefordert wurde', async () => {
    const { service, user } = build();

    expect((await service.resolve(user.id, '12345678', false)).kind).toBe(
      'no_code',
    );
  });

  it('lässt einen Einrichtungscode keine Anmeldung abschließen', async () => {
    const { service, user } = build();
    const result = await service.request(user.id, TARGET, true);
    if (result.kind !== 'generated') throw new Error('Kein Code erzeugt.');

    expect((await service.resolve(user.id, result.code, false)).kind).toBe(
      'wrong_purpose',
    );
    expect((await service.resolve(user.id, result.code, true)).kind).toBe(
      'ok',
    );
  });
});

describe('E-Mail-Anmeldecode — Zieladresse', () => {
  it('nimmt die Konto-E-Mail, solange keine eigene hinterlegt ist', () => {
    const { service } = build();
    expect(
      service.targetAddress({ email: 'a@example.com', loginCodeEmail: null }),
    ).toBe('a@example.com');
  });

  it('bevorzugt die ausdrücklich hinterlegte Adresse', () => {
    const { service } = build();
    expect(
      service.targetAddress({
        email: 'a@example.com',
        loginCodeEmail: 'b@example.com',
      }),
    ).toBe('b@example.com');
  });
});
