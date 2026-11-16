import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { JWK, JWTVerifyGetKey, KeyLike } from 'jose';
import {
  IdTokenError,
  hasSecondFactor,
  verifyIdToken,
} from './id-token';

/**
 * Prüfung des ID-Tokens mit SELBST ERZEUGTEN Ed25519-Schlüsseln.
 *
 * Jeder Fall ändert genau EINE Sache an einem sonst gültigen Token; so ist
 * jeder Test auch der Beleg, dass der Normalfall durchgeht.
 */

const ISSUER = 'https://portal.example.test';
const CLIENT = 'meine-verwaltung';
const NONCE = 'nonce-12345';
const NOW = new Date('2026-11-16T12:00:00Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);

interface Keys {
  priv: KeyLike;
  jwk: JWK;
  getKey: JWTVerifyGetKey;
}

async function makeKeys(kid: string): Promise<Keys> {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: 'EdDSA' };
  // Wie das JWKS des Portals: Schlüssel anhand der `kid` heraussuchen.
  const getKey: JWTVerifyGetKey = async (header) => {
    if (header.kid !== kid) throw new Error('kid unbekannt');
    const { importJWK } = await import('jose');
    return importJWK(jwk, 'EdDSA') as Promise<KeyLike>;
  };
  return { priv: pair.privateKey, jwk, getKey };
}

function claims(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: CLIENT,
    sub: 'konto-1',
    nonce: NONCE,
    auth_time: NOW_S - 20,
    amr: ['pwd', 'otp'],
    sid: 'sid-1',
    email: 'Person@Example.test',
    name: 'Erika Muster',
    roles: { [CLIENT]: 'admin', andere: 'staff' },
    iat: NOW_S - 10,
    exp: NOW_S + 290,
    ...extra,
  };
}

async function sign(
  payload: Record<string, unknown>,
  key: KeyLike,
  kid: string,
  alg = 'EdDSA',
): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg, kid }).sign(key);
}

const EXPECT = { issuer: ISSUER, clientId: CLIENT, nonce: NONCE, now: NOW };

describe('verifyIdToken', () => {
  let keys: Keys;
  beforeAll(async () => {
    keys = await makeKeys('k1');
  });

  async function rejects(token: string, part: string | RegExp): Promise<void> {
    const error = await verifyIdToken(token, keys.getKey, EXPECT).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(IdTokenError);
    expect((error as IdTokenError).reason).toMatch(part);
  }

  it('nimmt ein gültiges Token an und liest die Rolle dieser Verwaltung', async () => {
    const token = await sign(claims(), keys.priv, 'k1');
    const result = await verifyIdToken(token, keys.getKey, EXPECT);
    expect(result).toEqual({
      issuer: ISSUER,
      subject: 'konto-1',
      email: 'person@example.test',
      name: 'Erika Muster',
      authTime: NOW_S - 20,
      amr: ['pwd', 'otp'],
      sid: 'sid-1',
      role: 'admin',
    });
  });

  it('weist ein falsches aud ab', async () => {
    await rejects(await sign(claims({ aud: 'andere-verwaltung' }), keys.priv, 'k1'), /aud/i);
  });

  it('weist ein falsches iss ab', async () => {
    await rejects(
      await sign(claims({ iss: 'https://boese.example.test' }), keys.priv, 'k1'),
      /iss/i,
    );
  });

  it('weist ein abgelaufenes Token ab', async () => {
    await rejects(
      await sign(claims({ exp: NOW_S - 1 }), keys.priv, 'k1'),
      /exp/i,
    );
  });

  it('weist eine Signatur mit fremdem Schlüssel ab', async () => {
    const stranger = await makeKeys('k1');
    await rejects(await sign(claims(), stranger.priv, 'k1'), /Signatur|JWS/i);
  });

  it('weist eine unbekannte kid ab', async () => {
    await rejects(await sign(claims(), keys.priv, 'andere-kid'), /abgewiesen/);
  });

  it('weist eine falsche nonce ab', async () => {
    await rejects(
      await sign(claims({ nonce: 'eine-andere' }), keys.priv, 'k1'),
      /nonce/i,
    );
  });

  it('weist ein Token ohne nonce ab', async () => {
    const payload = claims();
    delete payload['nonce'];
    await rejects(await sign(payload, keys.priv, 'k1'), /nonce/i);
  });

  it('weist ein fehlendes amr ab', async () => {
    const payload = claims();
    delete payload['amr'];
    await rejects(await sign(payload, keys.priv, 'k1'), /amr/);
  });

  it('weist ein leeres amr ab', async () => {
    await rejects(await sign(claims({ amr: [] }), keys.priv, 'k1'), /amr/);
  });

  it('weist ein amr mit Nicht-Text ab', async () => {
    await rejects(await sign(claims({ amr: ['pwd', 3] }), keys.priv, 'k1'), /amr/);
  });

  it('weist ein fehlendes auth_time ab', async () => {
    const payload = claims();
    delete payload['auth_time'];
    await rejects(await sign(payload, keys.priv, 'k1'), /auth_time/);
  });

  it('weist ein fehlendes sid ab', async () => {
    const payload = claims();
    delete payload['sid'];
    await rejects(await sign(payload, keys.priv, 'k1'), /sid/);
  });

  it('erlaubt iat bis 60 s in der Zukunft, aber nicht darüber', async () => {
    const ok = await sign(claims({ iat: NOW_S + 60 }), keys.priv, 'k1');
    await expect(verifyIdToken(ok, keys.getKey, EXPECT)).resolves.toBeDefined();
    await rejects(
      await sign(claims({ iat: NOW_S + 61 }), keys.priv, 'k1'),
      /iat|Zukunft/i,
    );
  });

  it('lässt nur EdDSA zu: ein HMAC-Token mit bekanntem Schlüssel scheitert', async () => {
    const hmac = await new SignJWT(claims())
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .sign(new TextEncoder().encode('ein-geheimnis-von-mindestens-32-zeichen'));
    await rejects(hmac, /abgewiesen/);
  });

  it('lässt ein unsigniertes Token (alg none) nicht durch', async () => {
    const part = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const none = `${part({ alg: 'none', kid: 'k1' })}.${part(claims())}.`;
    await rejects(none, /abgewiesen/);
  });

  it('meldet fehlende Rolle als role=null, nicht als Prüffehler', async () => {
    const token = await sign(claims({ roles: { andere: 'admin' } }), keys.priv, 'k1');
    expect((await verifyIdToken(token, keys.getKey, EXPECT)).role).toBeNull();
    const none = await sign(claims({ roles: {} }), keys.priv, 'k1');
    expect((await verifyIdToken(none, keys.getKey, EXPECT)).role).toBeNull();
    const absent = claims();
    delete absent['roles'];
    expect(
      (await verifyIdToken(await sign(absent, keys.priv, 'k1'), keys.getKey, EXPECT)).role,
    ).toBeNull();
  });

  it('akzeptiert als Rolle nur admin oder staff', async () => {
    const token = await sign(
      claims({ roles: { [CLIENT]: 'superuser' } }),
      keys.priv,
      'k1',
    );
    expect((await verifyIdToken(token, keys.getKey, EXPECT)).role).toBeNull();
    const staff = await sign(claims({ roles: { [CLIENT]: 'staff' } }), keys.priv, 'k1');
    expect((await verifyIdToken(staff, keys.getKey, EXPECT)).role).toBe('staff');
  });
});

describe('hasSecondFactor', () => {
  it('zählt otp und hwk (Passkey), nicht pwd allein', () => {
    expect(hasSecondFactor(['pwd'])).toBe(false);
    expect(hasSecondFactor(['pwd', 'otp'])).toBe(true);
    expect(hasSecondFactor(['hwk'])).toBe(true);
    expect(hasSecondFactor([])).toBe(false);
  });
});
