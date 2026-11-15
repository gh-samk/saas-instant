import { describe, expect, it } from 'vitest';
import { NonceStore, sha256hex, signRequest, signatureFor, verifyRequest } from '../src/hmac.js';
import { SECRET, startHarness } from './helpers.js';

const base = (over: Partial<Parameters<typeof verifyRequest>[0]> = {}) => {
  const body = Buffer.from('{"a":1}');
  const headers = signRequest(SECRET, 'POST', '/v1/jobs?x=1', body, 1_000_000_000_000);
  return { secret: SECRET, method: 'POST', url: '/v1/jobs?x=1', headers, body, nonces: new NonceStore(), now: 1_000_000_000_000, ...over };
};

describe('HMAC-Pruefung', () => {
  it('akzeptiert eine gueltige Anfrage', () => {
    expect(verifyRequest(base()).ok).toBe(true);
  });

  it('bildet die Signatur exakt nach der Vorgabe', () => {
    const sig = signatureFor('k', 'get', '/v1/health', '123', 'ab'.repeat(16), '');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('lehnt abgelaufene Zeitstempel ab (beide Richtungen)', () => {
    expect(verifyRequest(base({ now: 1_000_000_061_000 })).ok).toBe(false);
    expect(verifyRequest(base({ now: 999_999_939_000 })).ok).toBe(false);
    expect(verifyRequest(base({ now: 1_000_000_059_000 })).ok).toBe(true);
  });

  it('lehnt eine wiederholte Nonce ab', () => {
    const args = base();
    expect(verifyRequest(args).ok).toBe(true);
    const again = verifyRequest(args);
    expect(again.ok).toBe(false);
  });

  it('vergisst Nonces nach fuenf Minuten', () => {
    const store = new NonceStore();
    expect(store.remember('n1', 0)).toBe(true);
    expect(store.remember('n1', 299_000)).toBe(false);
    expect(store.remember('n1', 301_000)).toBe(true);
  });

  it('lehnt einen veraenderten Body, Pfad, andere Methode und falsches Geheimnis ab', () => {
    expect(verifyRequest(base({ body: Buffer.from('{"a":2}') })).ok).toBe(false);
    expect(verifyRequest(base({ url: '/v1/jobs?x=2' })).ok).toBe(false);
    expect(verifyRequest(base({ method: 'PUT' })).ok).toBe(false);
    expect(verifyRequest(base({ secret: 'ein-anderes-geheimnis-0123456789abcdef' })).ok).toBe(false);
  });

  it('lehnt fehlende oder fehlerhafte Header ab, ohne die Nonce zu verbrauchen', () => {
    const args = base();
    expect(verifyRequest({ ...args, headers: {} }).ok).toBe(false);
    expect(verifyRequest({ ...args, headers: { ...args.headers, 'x-si-nonce': 'zz' } }).ok).toBe(false);
    expect(verifyRequest(args).ok).toBe(true);
  });
});

describe('HTTP-Server', () => {
  it('antwortet nur auf signierte Anfragen und lehnt Replay, falschen Body und Uebergroesse ab', async () => {
    const h = await startHarness();
    try {
      const ok = await h.call('GET', '/v1/health');
      expect(ok.status).toBe(200);
      expect(ok.json).toEqual({ status: 'ok', version: 'test', targetConfigured: false });

      const unsigned = await fetch(h.base + '/v1/health');
      expect(unsigned.status).toBe(401);

      // Replay: gleiche Header zweimal
      const headers = signRequest(SECRET, 'GET', '/v1/health');
      expect((await fetch(h.base + '/v1/health', { headers })).status).toBe(200);
      expect((await fetch(h.base + '/v1/health', { headers })).status).toBe(401);

      // Body passt nicht zur Signatur
      const h2 = signRequest(SECRET, 'PUT', '/v1/target', '{"x":1}');
      const bad = await fetch(h.base + '/v1/target', { method: 'PUT', headers: h2, body: '{"x":2}' });
      expect(bad.status).toBe(401);

      // Uebergroesse
      const big = 'x'.repeat(1024 * 1024 + 10);
      const h3 = signRequest(SECRET, 'PUT', '/v1/target', big);
      const r = await fetch(h.base + '/v1/target', { method: 'PUT', headers: h3, body: big });
      expect(r.status).toBe(413);

      // Falsches Geheimnis
      expect((await h.call('GET', '/v1/health', undefined, { secret: 'falsches-geheimnis-0123456789abcdef0123' })).status).toBe(401);
    } finally {
      await h.close();
    }
  });
});
