import { randomInt } from 'crypto';
import { hashPassword, verifyPasswordOrFalse } from './password';

/** Es werden immer genau acht Codes ausgegeben. */
export const COUNT_CODES = 8;
/** Zeichen je Gruppe (zwei Gruppen je Code). */
const CHARS_PER_GROUP = 4;
/**
 * Zeichenvorrat ohne verwechselbare Zeichen (kein 0/O, 1/l/I). Die Codes
 * werden ausgedruckt und von Hand abgetippt.
 */
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

/**
 * Bringt eine Eingabe auf die Normalform, gegen die gehasht wird:
 * Kleinbuchstaben, nur Zeichen aus dem Alphabet, keine Trenner.
 * So sind „ABCD-EFGH", „abcd efgh" und „abcdefgh" derselbe Code.
 */
export function normalizeCode(input: string): string {
  const small = input.toLowerCase();
  let result = '';
  for (const chars of small) {
    if (ALPHABET.includes(chars)) result += chars;
  }
  return result;
}

/** Ein Code in Anzeigeform, z. B. „abcd-efgh". */
export function generateCode(): string {
  let raw = '';
  for (let i = 0; i < CHARS_PER_GROUP * 2; i += 1) {
    raw += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return `${raw.slice(0, CHARS_PER_GROUP)}-${raw.slice(CHARS_PER_GROUP)}`;
}

/** Hash eines Codes (argon2id über die Normalform). */
export function hashRecoveryCode(code: string): Promise<string> {
  return hashPassword(normalizeCode(code));
}

/**
 * Erzeugt `count` Codes samt Hashes. Die Klartexte sind die einzige
 * Gelegenheit, sie zu sehen; gespeichert werden nur die Hashes.
 */
export async function generateRecoveryCodes(
  count: number = COUNT_CODES,
): Promise<{ codes: string[]; hashes: string[] }> {
  const codes: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const code = generateCode();
    codes.push(code);
    hashes.push(await hashRecoveryCode(code));
  }
  return { codes, hashes };
}

/**
 * Sucht unter den offenen Codes den, der zur Eingabe passt, und liefert dessen
 * `id` — oder null. Ein beschädigter Hash macht nur diesen Code unbrauchbar.
 * Das Entwerten (atomar, einmalig) bleibt Sache des Speichers.
 */
export async function findMatchingRecoveryCode<T extends { codeHash: string }>(
  open: readonly T[],
  input: string,
): Promise<T | null> {
  const normalized = normalizeCode(input);
  if (normalized.length === 0) return null;
  for (const candidate of open) {
    if (await verifyPasswordOrFalse(candidate.codeHash, normalized)) {
      return candidate;
    }
  }
  return null;
}
