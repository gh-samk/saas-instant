import { describe, expect, it } from 'vitest';
import {
  burnHashTime,
  hashPassword,
  verifyAgainstDummy,
  verifyPassword,
  verifyPasswordOrFalse,
} from './password';

describe('password', () => {
  it('hasht mit argon2id und prüft richtig/falsch', async () => {
    const hash = await hashPassword('geheim-123');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'geheim-123')).toBe(true);
    expect(await verifyPassword(hash, 'falsch')).toBe(false);
  });

  it('verifyPassword wirft bei beschädigtem Hash, verifyPasswordOrFalse nicht', async () => {
    await expect(verifyPassword('kaputt', 'x')).rejects.toBeDefined();
    expect(await verifyPasswordOrFalse('kaputt', 'x')).toBe(false);
  });

  it('Wegwerf-Hash und Zeitverbrennung laufen ohne Fehler', async () => {
    await expect(verifyAgainstDummy('irgendwas')).resolves.toBeUndefined();
    await expect(burnHashTime()).resolves.toBeUndefined();
  });
});
