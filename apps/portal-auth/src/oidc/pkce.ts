import { createHash, timingSafeEqual } from 'crypto';

/** Zeichen und Länge laut RFC 7636. */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9\-_]{43,128}$/;

export function isValidChallenge(challenge: string): boolean {
  return CHALLENGE.test(challenge);
}

/** S256: BASE64URL(SHA256(verifier)) == challenge, zeitkonstant verglichen. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!VERIFIER.test(verifier)) return false;
  const computed = Buffer.from(createHash('sha256').update(verifier, 'ascii').digest('base64url'));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}
