import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const MAX_SKEW_MS = 60_000;
export const NONCE_TTL_MS = 5 * 60_000;
export const MAX_BODY_BYTES = 1024 * 1024;

export function sha256hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function signatureFor(
  secret: string,
  method: string,
  pathWithQuery: string,
  timestamp: string,
  nonce: string,
  body: Buffer | string,
): string {
  const canonical = [method.toUpperCase(), pathWithQuery, timestamp, nonce, sha256hex(body)].join('\n');
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

/** Erzeugt die drei Header (Gegenstueck fuer Verwaltung und Tests). */
export function signRequest(
  secret: string,
  method: string,
  pathWithQuery: string,
  body: Buffer | string = '',
  now: number = Date.now(),
  nonce?: string,
): Record<string, string> {
  const n = nonce ?? createHash('sha256').update(`${now}:${Math.random()}:${process.hrtime.bigint()}`).digest('hex').slice(0, 32);
  const ts = String(now);
  return {
    'x-si-timestamp': ts,
    'x-si-nonce': n,
    'x-si-signature': signatureFor(secret, method, pathWithQuery, ts, n, body),
  };
}

export class NonceStore {
  private seen = new Map<string, number>();

  constructor(private readonly ttlMs = NONCE_TTL_MS) {}

  /** true = neu (und jetzt gemerkt), false = Wiederholung. */
  remember(nonce: string, now: number): boolean {
    for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, now + this.ttlMs);
    return true;
  }
}

export type VerifyResult = { ok: true } | { ok: false; status: number; reason: string };

function header(h: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
}

export function verifyRequest(args: {
  secret: string;
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  nonces: NonceStore;
  now?: number;
}): VerifyResult {
  const now = args.now ?? Date.now();
  const ts = header(args.headers, 'x-si-timestamp');
  const nonce = header(args.headers, 'x-si-nonce');
  const sig = header(args.headers, 'x-si-signature');
  if (!ts || !nonce || !sig) return { ok: false, status: 401, reason: 'Signatur fehlt' };
  if (!/^\d{10,16}$/.test(ts)) return { ok: false, status: 401, reason: 'Zeitstempel ungueltig' };
  if (!/^[0-9a-f]{32,128}$/i.test(nonce)) return { ok: false, status: 401, reason: 'Nonce ungueltig' };
  if (!/^[0-9a-f]{64}$/i.test(sig)) return { ok: false, status: 401, reason: 'Signatur ungueltig' };
  if (Math.abs(now - Number(ts)) > MAX_SKEW_MS) return { ok: false, status: 401, reason: 'Zeitstempel abgelaufen' };
  const expected = Buffer.from(signatureFor(args.secret, args.method, args.url, ts, nonce, args.body), 'hex');
  const given = Buffer.from(sig, 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, status: 401, reason: 'Signatur ungueltig' };
  }
  // Erst NACH gueltiger Signatur merken, damit Unbefugte den Speicher nicht fuellen.
  if (!args.nonces.remember(nonce.toLowerCase(), now)) return { ok: false, status: 401, reason: 'Wiederholung' };
  return { ok: true };
}
