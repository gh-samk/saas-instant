import { authHeaders, sha256Hex, sign, signingString } from './agent-signature';

/**
 * REFERENZVEKTOR der Schnittstelle (Verwaltung <-> Agent). Der Agent muss
 * denselben Wert errechnen; der Vektor wurde unabhängig mit `crypto` bestimmt:
 *
 *   HMAC-SHA256(secret, "POST\n/v1/jobs?x=1\n1700000000000\n<nonce>\n<sha256(body)>")
 */
const SECRET = 'test-secret-0123456789abcdef0123456789';
const NONCE = '00112233445566778899aabbccddeeff';
const BODY = '{"a":1}';

describe('HMAC-Signatur des Sicherungs-Agents', () => {
  it('errechnet den Referenzvektor', () => {
    expect(sha256Hex(BODY)).toBe(
      '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862',
    );
    expect(
      sign(SECRET, {
        method: 'POST',
        pathWithQuery: '/v1/jobs?x=1',
        timestamp: '1700000000000',
        nonce: NONCE,
        body: BODY,
      }),
    ).toBe('970bfeb2264cafff53f8a44f7dfc875dfb905078dde74ad23fda326a6b4f6cbb');
  });

  it('signiert METHODE, Pfad mit Query, Zeit, Nonce und Body-Hash, getrennt durch Zeilenumbrüche', () => {
    expect(
      signingString({
        method: 'get',
        pathWithQuery: '/v1/health',
        timestamp: '1',
        nonce: NONCE,
        body: '',
      }),
    ).toBe(
      `GET\n/v1/health\n1\n${NONCE}\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
    );
  });

  it('ändert die Signatur bei jeder Veränderung der Anfrage', () => {
    const base = {
      method: 'POST',
      pathWithQuery: '/v1/jobs',
      timestamp: '1700000000000',
      nonce: NONCE,
      body: BODY,
    };
    const reference = sign(SECRET, base);
    for (const changed of [
      { ...base, method: 'PUT' },
      { ...base, pathWithQuery: '/v1/jobs?a=1' },
      { ...base, timestamp: '1700000000001' },
      { ...base, nonce: 'ff'.repeat(16) },
      { ...base, body: '{"a":2}' },
    ]) {
      expect(sign(SECRET, changed)).not.toBe(reference);
    }
    expect(sign('anderes-geheimnis-mit-genug-laenge-0123', base)).not.toBe(reference);
  });

  it('liefert Zeitstempel, Nonce (mindestens 16 Byte hex) und Signatur', () => {
    const headers = authHeaders(SECRET, { method: 'GET', pathWithQuery: '/v1/health', body: '' }, () => 5);
    expect(headers['X-SI-Timestamp']).toBe('5');
    expect(headers['X-SI-Nonce']).toMatch(/^[0-9a-f]{32,}$/);
    expect(headers['X-SI-Signature']).toMatch(/^[0-9a-f]{64}$/);
    const second = authHeaders(SECRET, { method: 'GET', pathWithQuery: '/v1/health', body: '' });
    const third = authHeaders(SECRET, { method: 'GET', pathWithQuery: '/v1/health', body: '' });
    expect(second['X-SI-Nonce']).not.toBe(third['X-SI-Nonce']);
  });
});
