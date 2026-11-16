import { createServer } from 'net';
import { createHash, randomBytes } from 'crypto';
import { authenticator } from 'otplib';
import { exportJWK, importJWK, jwtVerify, type JWK, type JWTPayload } from 'jose';
import type { INestApplication } from '@nestjs/common';
import { generateRecoveryCodes, hashPassword } from '@saas-instant/auth-core';
import { PrismaClient } from '.prisma/portal-auth-client';

/** Ein Test-Browser: eigener Cookie-Speicher, Weiterleitungen werden NICHT automatisch verfolgt. */
export class Browser {
  readonly cookies = new Map<string, string>();
  constructor(private readonly base: string) {}

  private cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request(
    method: string,
    path: string,
    opts: { json?: unknown; form?: Record<string, string>; csrf?: boolean; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; headers: Headers; body: any; text: string; location: string | null }> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    let body: string | undefined;
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(opts.form).toString();
    }
    if (opts.csrf !== false && method !== 'GET') {
      const csrf = this.cookies.get('portal_csrf') ?? (await this.fetchCsrf());
      headers['x-csrf-token'] = csrf;
      headers.cookie = this.cookieHeader();
    }
    const res = await fetch(`${this.base}${path}`, { method, headers, body, redirect: 'manual' });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0/i.test(a) || /expires=thu, 01 jan 1970/i.test(a));
      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* kein JSON */
    }
    return { status: res.status, headers: res.headers, body: parsed, text, location: res.headers.get('location') };
  }

  private async fetchCsrf(): Promise<string> {
    const r = await this.request('GET', '/api/auth/csrf');
    return r.body.csrf as string;
  }

  get(path: string) {
    return this.request('GET', path);
  }
  post(path: string, json: unknown = {}, headers?: Record<string, string>) {
    return this.request('POST', path, { json, headers });
  }
}

export interface TestAccount {
  id: string;
  email: string;
  password: string;
  secret: string;
  recoveryCodes: string[];
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function newPkce(): Pkce {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export class Harness {
  app!: INestApplication;
  prisma = new PrismaClient();
  base!: string;
  issuer!: string;
  secret = 'harness-key-secret-0123456789abcdef0123456789';
  private counter = 0;
  readonly runId = randomBytes(4).toString('hex');

  async start(): Promise<void> {
    const port = await freePort();
    this.issuer = `http://127.0.0.1:${port}`;
    this.base = this.issuer;
    Object.assign(process.env, {
      PORTAL_ISSUER: this.issuer,
      PORTAL_KEY_SECRET: this.secret,
      COOKIE_SECURE: 'false',
      PORTAL_RATE_LIMIT_DISABLED: '1',
      PORTAL_LOG: 'quiet',
      PORTAL_AUTH_PORT: String(port),
    });
    const { createApp } = await import('../app-factory');
    this.app = await createApp();
    await this.app.init();
    await this.app.listen(port, '127.0.0.1');
  }

  async stop(): Promise<void> {
    await this.app.close();
    await this.prisma.$disconnect();
  }

  browser(): Browser {
    return new Browser(this.base);
  }

  /** Neues, fertig eingerichtetes Konto (Passwort + TOTP + Wiederherstellungscodes). */
  async account(opts: { portalAdmin?: boolean; roles?: Record<string, 'admin' | 'staff'>; name?: string } = {}): Promise<TestAccount> {
    const { AccountsService } = await import('../accounts/accounts.service');
    const accounts = this.app.get(AccountsService);
    const email = `u${++this.counter}-${this.runId}@example.test`;
    const password = `Passwort-${randomBytes(6).toString('hex')}`;
    const secret = authenticator.generateSecret();
    const { codes, hashes } = await generateRecoveryCodes();
    const created = await this.prisma.account.create({
      data: {
        email,
        name: opts.name ?? `Test ${this.counter}`,
        passwordHash: await hashPassword(password),
        totpSecret: accounts.crypto.encrypt(secret),
        portalAdmin: opts.portalAdmin ?? false,
        recoveryCodes: { create: hashes.map((codeHash) => ({ codeHash })) },
      },
    });
    for (const [clientId, role] of Object.entries(opts.roles ?? {})) {
      await this.prisma.accountRole.create({ data: { accountId: created.id, clientId, role } });
    }
    return { id: created.id, email, password, secret, recoveryCodes: codes };
  }

  /** Registriert eine Verwaltung; liefert Secret und Adressen. */
  async client(slug: string, base = `https://${slug}.example.test`) {
    const { hashPassword: hash } = await import('@saas-instant/auth-core');
    const secret = `secret-${randomBytes(18).toString('hex')}`;
    const data = {
      name: `Verwaltung ${slug}`,
      secretHash: await hash(secret),
      redirectUris: [`${base}/api/auth/sso/callback`],
      frontchannelLogoutUri: `${base}/api/auth/sso/frontchannel-logout`,
      postLogoutRedirectUris: [`${base}/`],
    };
    await this.prisma.oidcClient.upsert({ where: { id: slug }, create: { id: slug, ...data }, update: data });
    return { id: slug, secret, redirectUri: data.redirectUris[0], logout: data.frontchannelLogoutUri, postLogout: data.postLogoutRedirectUris[0] };
  }

  /** Ein aktueller TOTP-Code; der Replay-Zähler wird vorher zurückgesetzt, damit mehrere Anmeldungen je Zeitschritt gehen. */
  async code(account: TestAccount): Promise<string> {
    await this.prisma.account.update({ where: { id: account.id }, data: { totpLastStep: null } });
    return authenticator.generate(account.secret);
  }

  async login(browser: Browser, account: TestAccount, extra: { req?: string } = {}) {
    return browser.post('/api/auth/login', {
      email: account.email,
      password: account.password,
      code: await this.code(account),
      ...extra,
    });
  }

  async jwks(): Promise<{ keys: JWK[] }> {
    const res = await fetch(`${this.base}/.well-known/jwks.json`);
    return (await res.json()) as { keys: JWK[] };
  }

  async verifyIdToken(token: string, audience: string): Promise<{ payload: JWTPayload; kid: string | undefined }> {
    const jwks = await this.jwks();
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    const jwk = jwks.keys.find((k) => k.kid === header.kid);
    if (!jwk) throw new Error(`kid ${header.kid} nicht im JWKS`);
    const key = await importJWK(jwk, 'EdDSA');
    const { payload } = await jwtVerify(token, key, { issuer: this.issuer, audience, algorithms: ['EdDSA'] });
    return { payload, kid: header.kid };
  }

  /** Authorize-Anfrage als URL-Pfad. */
  authorizePath(client: { id: string; redirectUri: string }, pkce: Pkce, extra: Record<string, string> = {}, state = 's-' + randomBytes(4).toString('hex'), nonce = 'n-' + randomBytes(4).toString('hex')) {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: client.id,
      redirect_uri: client.redirectUri,
      scope: 'openid',
      state,
      nonce,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      ...extra,
    });
    return { path: `/oauth/authorize?${q.toString()}`, state, nonce };
  }

  tokenRequest(browser: Browser, client: { id: string; secret: string; redirectUri: string }, code: string, verifier: string, over: Record<string, string> = {}) {
    return browser.request('POST', '/oauth/token', {
      csrf: false,
      form: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: client.redirectUri,
        code_verifier: verifier,
        client_id: client.id,
        client_secret: client.secret,
        ...over,
      },
    });
  }

  /** Aus einer Weiterleitung auf die Verwaltung den Code lesen. */
  codeFrom(location: string | null, client: { redirectUri: string }): { code: string; state: string | null; iss: string | null } {
    if (!location || !location.startsWith(client.redirectUri)) throw new Error(`Keine Rückleitung zur Verwaltung: ${location}`);
    const url = new URL(location);
    const code = url.searchParams.get('code');
    if (!code) throw new Error(`Kein code in ${location}`);
    return { code, state: url.searchParams.get('state'), iss: url.searchParams.get('iss') };
  }

  async cleanup(): Promise<void> {
    await this.prisma.account.deleteMany({ where: { email: { endsWith: `-${this.runId}@example.test` } } });
  }
}

export { exportJWK };
