import { describe, expect, it } from 'vitest';
import {
  COUNT_CODES,
  findMatchingRecoveryCode,
  generateCode,
  generateRecoveryCodes,
  normalizeCode,
} from './recovery-codes';

describe('recovery-codes', () => {
  it('Normalform ignoriert Groß-/Kleinschreibung und Trenner', () => {
    expect(normalizeCode('ABCD-efgh')).toBe('abcdefgh');
    expect(normalizeCode('abcd efgh')).toBe('abcdefgh');
    expect(normalizeCode('0O1lI-')).toBe('');
  });

  it('Code hat die Form xxxx-xxxx ohne verwechselbare Zeichen', () => {
    expect(generateCode()).toMatch(/^[2-9a-hjkmnp-z]{4}-[2-9a-hjkmnp-z]{4}$/);
  });

  it('erzeugt acht Codes mit passenden Hashes und findet den richtigen', async () => {
    const { codes, hashes } = await generateRecoveryCodes();
    expect(codes).toHaveLength(COUNT_CODES);
    expect(new Set(codes).size).toBe(COUNT_CODES);
    const open = hashes.map((codeHash, id) => ({ id, codeHash }));
    const found = await findMatchingRecoveryCode(open, codes[3].toUpperCase());
    expect(found?.id).toBe(3);
    expect(await findMatchingRecoveryCode(open, 'zzzz-zzzz')).toBeNull();
    expect(await findMatchingRecoveryCode(open, '---')).toBeNull();
  });

  it('ein beschädigter Hash macht nur diesen Code unbrauchbar', async () => {
    const { codes, hashes } = await generateRecoveryCodes(2);
    const open = [
      { id: 0, codeHash: 'kaputt' },
      { id: 1, codeHash: hashes[1] },
    ];
    expect((await findMatchingRecoveryCode(open, codes[1]))?.id).toBe(1);
  });
});
