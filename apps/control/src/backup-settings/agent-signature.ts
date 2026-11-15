import { createHash, createHmac, randomBytes } from 'crypto';

/**
 * HMAC-Signatur der Anfragen an den Sicherungs-Agent (Schnittstelle
 * Verwaltung <-> Agent, vom Architekten festgelegt).
 *
 *   X-SI-Timestamp: ms seit Epoche
 *   X-SI-Nonce:     mindestens 16 Byte hex
 *   X-SI-Signature: hex(HMAC-SHA256(secret,
 *                       METHOD \n PFAD_MIT_QUERY \n TIMESTAMP \n NONCE \n sha256hex(body)))
 *
 * Der Agent lehnt ab: |jetzt - Zeitstempel| > 60 s, wiederholte Nonce,
 * falsche Signatur, Body > 1 MiB.
 */

export function sha256Hex(body: string | Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/** Die zu signierende Zeichenkette. `body` sind die exakt gesendeten Bytes. */
export function signingString(input: {
  method: string;
  pathWithQuery: string;
  timestamp: string;
  nonce: string;
  body: string | Buffer;
}): string {
  return [
    input.method.toUpperCase(),
    input.pathWithQuery,
    input.timestamp,
    input.nonce,
    sha256Hex(input.body),
  ].join('\n');
}

export function sign(
  secret: string,
  input: {
    method: string;
    pathWithQuery: string;
    timestamp: string;
    nonce: string;
    body: string | Buffer;
  },
): string {
  return createHmac('sha256', secret).update(signingString(input), 'utf8').digest('hex');
}

/** Die drei Kopfzeilen einer Anfrage; Zeit und Nonce sind für Tests einsetzbar. */
export function authHeaders(
  secret: string,
  request: { method: string; pathWithQuery: string; body: string | Buffer },
  now: () => number = Date.now,
  nonce: () => string = () => randomBytes(16).toString('hex'),
): Record<string, string> {
  const timestamp = String(now());
  const n = nonce();
  return {
    'X-SI-Timestamp': timestamp,
    'X-SI-Nonce': n,
    'X-SI-Signature': sign(secret, { ...request, timestamp, nonce: n }),
  };
}
