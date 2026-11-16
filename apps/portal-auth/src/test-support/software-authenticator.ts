import { createHash, generateKeyPairSync, sign, type KeyObject } from 'crypto';

/** Minimaler CBOR-Schreiber für genau die Strukturen, die WebAuthn braucht. */
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
}
type Cbor = number | string | Buffer | Map<Cbor, Cbor>;
function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  const parts: Buffer[] = [head(5, value.size)];
  for (const [k, v] of value) parts.push(cbor(k), cbor(v));
  return Buffer.concat(parts);
}

const b64u = (b: Buffer) => b.toString('base64url');
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();

/** Ein Software-Authenticator (ES256, Benutzerverifikation immer „ja") für Tests. */
export class SoftwareAuthenticator {
  readonly credentialId = Buffer.from(`cred-${Math.random().toString(16).slice(2)}-${Date.now()}`);
  private readonly privateKey: KeyObject;
  private readonly publicJwk: { x: string; y: string };
  counter = 0;

  constructor(private readonly rpId: string, private readonly origin: string) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    this.publicJwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }

  /** Antwort auf `navigator.credentials.create()`. */
  register(options: { challenge: string }) {
    const cose = new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(this.publicJwk.x, 'base64url')],
      [-3, Buffer.from(this.publicJwk.y, 'base64url')],
    ]);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([0x45]), counter, Buffer.alloc(16), idLen, this.credentialId, cbor(cose)]);
    const attestationObject = cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(this.clientData('webauthn.create', options.challenge)),
        attestationObject: b64u(attestationObject),
        transports: ['internal'],
      },
    };
  }

  /** Antwort auf `navigator.credentials.get()`. */
  assert(options: { challenge: string }, over: { counter?: number; corruptSignature?: boolean; userHandle?: string } = {}) {
    this.counter = over.counter ?? this.counter + 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([0x05]), counter]);
    const clientData = this.clientData('webauthn.get', options.challenge);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.privateKey);
    if (over.corruptSignature) signature[signature.length - 1] ^= 0xff;
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientData),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: over.userHandle,
      },
    };
  }
}
