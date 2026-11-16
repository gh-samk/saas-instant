import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { JWK, KeyLike } from 'jose';

/**
 * Ein kleiner, ECHTER OIDC-Anbieter für Tests — nach dem Vertrag des Portals:
 * `/.well-known/jwks.json` (Ed25519), `/oauth/authorize`, `/oauth/token`.
 *
 * Er läuft als HTTP-Server auf einem freien Port und tut, was das Portal tut:
 * Code einmalig und 60 s gültig, PKCE (S256) Pflicht, `redirect_uri` exakt,
 * `client_secret_post`, ID-Token mit `iss`, `aud`, `sub`, `exp`, `iat`,
 * `nonce`, `auth_time`, `amr`, `sid`, `email`, `name`, `roles`.
 *
 * Für Fehlerfälle lassen sich einzelne Claims überschreiben (`overrides`), die
 * Signatur mit einem fremden Schlüssel erzeugen (`signWith`) und der
 * Signaturschlüssel wechseln (`rotateKey`).
 */

export interface FakeAccount {
  sub: string;
  email: string;
  name: string;
  /** `roles` im Token: Slug -> Rolle. */
  roles: Record<string, 'admin' | 'staff'>;
  sid: string;
}

interface CodeEntry {
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string;
  maxAgeZero: boolean;
  expires: number;
  used: boolean;
}

export interface TokenRequestLog {
  grantType: string | null;
  clientId: string | null;
  usedCode: boolean;
}

export class FakeOidcProvider {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  /** Das Konto, das sich „anmeldet". */
  account: FakeAccount;
  /** `amr` einer normalen Anmeldung (bestehende Sitzung). */
  loginAmr: string[] = ['pwd', 'otp'];
  /** `amr` einer erzwungenen Neuanmeldung (`max_age=0`). */
  stepUpAmr: string[] = ['pwd', 'otp'];
  /** Alter der bestehenden Portal-Sitzung in Sekunden (für `auth_time`). */
  sessionAgeSeconds = 30;
  /** Zusätzliche/überschriebene Claims im nächsten und allen folgenden Tokens. */
  overrides: Record<string, unknown> = {};
  /** Claims, die weggelassen werden. */
  omit: string[] = [];
  /** Mit diesem (fremden) Schlüssel statt mit dem veröffentlichten signieren. */
  signWithForeignKey = false;
  readonly tokenRequests: TokenRequestLog[] = [];

  private server!: Server;
  private keyId = 'k1';
  private privateKey!: KeyLike;
  private publicJwk!: JWK;
  private foreignKey!: KeyLike;
  private readonly codes = new Map<string, CodeEntry>();
  /** Zähler: wie oft das JWKS abgerufen wurde. */
  jwksFetches = 0;

  private constructor(options: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    account: FakeAccount;
  }) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.redirectUri = options.redirectUri;
    this.account = options.account;
  }

  static async start(options: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    account: FakeAccount;
  }): Promise<FakeOidcProvider> {
    const provider = new FakeOidcProvider(options);
    await provider.rotateKey();
    provider.foreignKey = (
      await generateKeyPair('EdDSA', { crv: 'Ed25519' })
    ).privateKey;
    provider.server = createServer((req, res) => {
      void provider.handle(req, res).catch((error: unknown) => {
        res.statusCode = 500;
        res.end(String(error));
      });
    });
    await new Promise<void>((resolve) =>
      provider.server.listen(0, '127.0.0.1', resolve),
    );
    return provider;
  }

  get issuer(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Neuer Signaturschlüssel mit neuer `kid` (Schlüsselwechsel des Portals). */
  async rotateKey(): Promise<void> {
    const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    this.privateKey = pair.privateKey;
    this.keyId = `k-${randomBytes(4).toString('hex')}`;
    this.publicJwk = {
      ...(await exportJWK(pair.publicKey)),
      kid: this.keyId,
      alg: 'EdDSA',
      use: 'sig',
    };
  }

  resetBehavior(): void {
    this.overrides = {};
    this.omit = [];
    this.signWithForeignKey = false;
    this.loginAmr = ['pwd', 'otp'];
    this.stepUpAmr = ['pwd', 'otp'];
    this.sessionAgeSeconds = 30;
  }

  /** Ein Code, der abgelaufen ist (für den Test „Code ist 60 s gültig"). */
  expireAllCodes(): void {
    for (const entry of this.codes.values()) entry.expires = Date.now() - 1;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.issuer);
    if (req.method === 'GET' && url.pathname === '/.well-known/jwks.json') {
      this.jwksFetches += 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [this.publicJwk] }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
      this.authorize(url, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/oauth/token') {
      await this.token(req, res);
      return;
    }
    res.statusCode = 404;
    res.end();
  }

  private authorize(url: URL, res: ServerResponse): void {
    const q = url.searchParams;
    const fail = (message: string): void => {
      res.statusCode = 400;
      res.end(message);
    };
    if (q.get('response_type') !== 'code') return fail('response_type');
    if (q.get('client_id') !== this.clientId) return fail('client_id');
    if (q.get('redirect_uri') !== this.redirectUri) return fail('redirect_uri');
    if (q.get('scope') !== 'openid') return fail('scope');
    if (q.get('code_challenge_method') !== 'S256') return fail('pkce');
    const challenge = q.get('code_challenge');
    const state = q.get('state');
    const nonce = q.get('nonce');
    if (!challenge || !state || !nonce) return fail('fehlende Parameter');

    const code = randomBytes(24).toString('base64url');
    this.codes.set(code, {
      clientId: this.clientId,
      redirectUri: this.redirectUri,
      challenge,
      nonce,
      maxAgeZero: q.get('max_age') === '0' || q.get('prompt') === 'login',
      expires: Date.now() + 60_000,
      used: false,
    });
    const target = new URL(this.redirectUri);
    target.searchParams.set('code', code);
    target.searchParams.set('state', state);
    res.statusCode = 302;
    res.setHeader('location', target.toString());
    res.end();
  }

  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const reject = (error: string): void => {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error }));
    };
    const code = form.get('code') ?? '';
    const entry = this.codes.get(code);
    this.tokenRequests.push({
      grantType: form.get('grant_type'),
      clientId: form.get('client_id'),
      usedCode: entry?.used === true,
    });
    if (req.headers['content-type'] !== 'application/x-www-form-urlencoded') {
      return reject('invalid_request');
    }
    if (form.get('grant_type') !== 'authorization_code') {
      return reject('unsupported_grant_type');
    }
    if (
      form.get('client_id') !== this.clientId ||
      form.get('client_secret') !== this.clientSecret
    ) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'invalid_client' }));
      return;
    }
    if (!entry || entry.used || entry.expires < Date.now()) {
      return reject('invalid_grant');
    }
    // Einmalig: ab jetzt verbraucht, auch wenn die weiteren Prüfungen scheitern.
    entry.used = true;
    if (form.get('redirect_uri') !== entry.redirectUri) {
      return reject('invalid_grant');
    }
    const verifier = form.get('code_verifier') ?? '';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    if (challenge !== entry.challenge) return reject('invalid_grant');

    const now = Math.floor(Date.now() / 1000);
    const authTime = entry.maxAgeZero ? now : now - this.sessionAgeSeconds;
    const claims: Record<string, unknown> = {
      iss: this.issuer,
      aud: this.clientId,
      sub: this.account.sub,
      nonce: entry.nonce,
      auth_time: authTime,
      amr: entry.maxAgeZero ? this.stepUpAmr : this.loginAmr,
      sid: this.account.sid,
      email: this.account.email,
      name: this.account.name,
      roles: this.account.roles,
      ...this.overrides,
    };
    for (const name of this.omit) delete claims[name];

    const signer = new SignJWT(claims).setProtectedHeader({
      alg: 'EdDSA',
      kid: this.keyId,
    });
    if (!('iat' in claims)) signer.setIssuedAt();
    if (!('exp' in claims)) signer.setExpirationTime('5m');
    const idToken = await signer.sign(
      this.signWithForeignKey ? this.foreignKey : this.privateKey,
    );
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(
      JSON.stringify({ id_token: idToken, token_type: 'Bearer', expires_in: 300 }),
    );
  }
}
