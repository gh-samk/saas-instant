// Hilfen der Suite sso: Portal-Anmeldedienst als Prozess, Portal-Vorderseite (statisch + Proxy),
// Attrappen-Aussteller für manipulierte Tokens, TOTP, Browser und HTTP-Hilfen.
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, request as httpRequest } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docker, run } from '../lib/docker.mjs';
import { E2E_OUT, updateState, waitFor, sleep } from '../lib/util.mjs';
import { ROOT, CONTROL_DIR, createDatabase, dropDatabase } from '../lib/control.mjs';
import { chromiumPath, PW_CORE } from '../install/helpers.mjs';

export const OUT = join(E2E_OUT, 'sso');
export const PORTAL_AUTH_DIR = join(ROOT, 'apps', 'portal-auth');
export const PORTAL_STATIC_DIR = join(ROOT, 'apps', 'portal');
const controlRequire = createRequire(join(CONTROL_DIR, 'package.json'));

const DB_HOST = process.env.E2E_DB_HOST || '127.0.0.1';
const DB_PORT = process.env.E2E_DB_PORT || '54329';
const DB_USER = process.env.E2E_DB_USER || 'postgres';
const DB_PASS = process.env.E2E_DB_PASSWORD || 'demo';
export const dbUrl = (name) => `postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${name}`;
const DB_CONTAINER = process.env.E2E_DB_CONTAINER || 'si-test-db';

/** Fehler, die ein Verhalten des PRODUKTS betreffen (nicht des Skripts). */
export function expect(cond, msg) {
  if (!cond) throw new Error(`PRODUKT: ${msg}`);
}

/** SQL gegen eine der e2e_*-Datenbanken (psql im Test-DB-Container). Liefert die Ausgabe ohne Kopfzeile. */
export async function sql(dbName, statement) {
  if (!/^e2e_[a-z0-9_]{1,40}$/.test(dbName)) throw new Error(`Datenbankname "${dbName}" ungültig`);
  const r = await docker(['exec', DB_CONTAINER, 'psql', '-U', DB_USER, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-tAc', statement]);
  return r.stdout.trim();
}

// ---------------------------------------------------------------------------
// TOTP (je Konto ein Zeitfenster höchstens einmal)
// ---------------------------------------------------------------------------
export function makeTotp(secret) {
  const { authenticator } = controlRequire('otplib');
  let lastStep = -1;
  return async () => {
    for (;;) {
      const step = Math.floor(Date.now() / 30_000);
      if (step !== lastStep) {
        lastStep = step;
        return authenticator.generate(secret);
      }
      await sleep(30_000 - (Date.now() % 30_000) + 300);
    }
  };
}

// ---------------------------------------------------------------------------
// Dienste als Prozesse
// ---------------------------------------------------------------------------
export function spawnService(name, args, { cwd, env, logName }) {
  mkdirSync(OUT, { recursive: true });
  const log = createWriteStream(join(OUT, logName ?? `${name}.log`), { flags: 'a' });
  const child = spawn('node', args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  let exited = null;
  child.on('exit', (code, sig) => { exited = `Code ${code ?? sig}`; });
  updateState((s) => s.pids.push(child.pid));
  return {
    pid: child.pid,
    exited: () => exited,
    async stop() {
      if (exited === null) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* weg */ }
        for (let i = 0; i < 40 && exited === null; i++) await sleep(250);
        if (exited === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* weg */ } }
      }
      log.end();
      updateState((s) => { s.pids = s.pids.filter((p) => p !== child.pid); });
    },
  };
}

/**
 * Startet den Anmeldedienst (portal-auth) aus dem Quellcode: eigene Datenbank, Migration, Prozess.
 * `issuer` ist die öffentliche Adresse der Portal-Vorderseite (portal.localhost), `port` der Port des Dienstes.
 */
export async function startPortalAuth({ port, issuer, dbName = 'e2e_sso_portal', build = true }) {
  await createDatabase(dbName);
  const env = {
    ...process.env,
    DATABASE_URL: dbUrl(dbName),
    PORTAL_ISSUER: issuer,
    PORTAL_KEY_SECRET: randomBytes(32).toString('hex'),
    COOKIE_SECURE: 'false',
    PORTAL_TRUST_PROXY: '1',
    PORTAL_AUTH_PORT: String(port),
    PORTAL_NAME: 'E2E-Portal',
    NODE_ENV: 'development',
  };
  if (build) await run('pnpm', ['exec', 'nest', 'build'], { cwd: PORTAL_AUTH_DIR, env, timeoutMs: 600_000 });
  await run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { cwd: PORTAL_AUTH_DIR, env, timeoutMs: 300_000 });
  const url = `http://127.0.0.1:${port}`;
  const svc = spawnService('portal-auth', ['dist/main'], { cwd: PORTAL_AUTH_DIR, env, logName: `portal-auth-${port}.log` });
  try {
    await waitFor(async () => {
      if (svc.exited()) throw new Error(`portal-auth vorzeitig beendet (${svc.exited()}); siehe ${OUT}/portal-auth-${port}.log`);
      const r = await fetch(`${url}/api/health`).catch(() => null);
      return r?.ok;
    }, { timeoutMs: 90_000, label: 'portal-auth /api/health', intervalMs: 500 });
  } catch (e) {
    await svc.stop();
    await dropDatabase(dbName).catch(() => {});
    throw e;
  }
  /** CLI des Anmeldedienstes (node dist/cli.js ...). Liefert { code, stdout, stderr }. */
  const cli = (args, { input } = {}) => run('node', ['dist/cli.js', ...args], { cwd: PORTAL_AUTH_DIR, env, input, allowFail: true, timeoutMs: 120_000 });
  return {
    url, port, dbName, env, cli, issuer,
    stop: async () => { await svc.stop(); },
    dispose: async () => { await svc.stop(); await dropDatabase(dbName).catch(() => {}); },
  };
}

// ---------------------------------------------------------------------------
// Portal-Vorderseite: statische Seiten (apps/portal) + Proxy zum Anmeldedienst
// (ersetzt den nginx des Portals; gleiche Aufteilung wie apps/portal/nginx.conf)
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.json': 'application/json',
};

export async function startPortalFront({ port, authPort, registry }) {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const proxied = path.startsWith('/api/') || path.startsWith('/oauth/') || path.startsWith('/.well-known/');
    if (proxied) {
      const headers = { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress ?? '127.0.0.1', 'x-forwarded-proto': 'http' };
      const up = httpRequest({ host: '127.0.0.1', port: authPort, method: req.method, path: req.url, headers }, (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
      });
      up.on('error', () => { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('Bad Gateway'); });
      req.pipe(up);
      return;
    }
    if (path === '/registry.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(registry));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    let file;
    if (path === '/' || path.startsWith('/auth/')) file = join(PORTAL_STATIC_DIR, 'index.html');
    else {
      file = normalize(join(PORTAL_STATIC_DIR, path));
      if (!file.startsWith(PORTAL_STATIC_DIR + '/')) { res.writeHead(404); res.end(); return; }
    }
    if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('Nicht gefunden'); return; }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, resolve); });
  return { port, stop: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

// ---------------------------------------------------------------------------
// Portal-Konten per HTTP (Einrichtung, Anmeldung ohne Browser)
// ---------------------------------------------------------------------------
/** Client mit Cookie-Speicher für den Anmeldedienst (CSRF per Double-Submit, Origin gesetzt). */
export function makePortalClient(base, origin) {
  const jar = new Map();
  let csrf = null;
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const absorb = (res) => {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = line.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (attrs.some((a) => /^\s*max-age=0/i.test(a)) || value === '') jar.delete(name); else jar.set(name, value);
    }
  };
  async function call(method, path, body, { form = false, follow = false } = {}) {
    const headers = {};
    if (method !== 'GET') {
      if (!csrf) {
        const r = await fetch(`${base}/api/auth/csrf`, { headers: { cookie: cookieHeader() } });
        absorb(r);
        csrf = (await r.json()).csrf;
      }
      headers['x-csrf-token'] = csrf;
      headers.origin = origin;
    }
    headers.cookie = cookieHeader();
    let payload;
    if (body !== undefined) {
      if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
      else { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    }
    const res = await fetch(`${base}${path}`, { method, headers, body: payload, redirect: follow ? 'follow' : 'manual' });
    absorb(res);
    const text = await res.text();
    let parsed = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
    return { status: res.status, ok: res.ok, headers: res.headers, body: parsed };
  }
  return { call, jar };
}

/**
 * Legt ein Konto per CLI an, richtet es über den Einrichtungslink ein (Passwort + TOTP)
 * und liefert { email, password, totpSecret, recoveryCodes, totp }.
 */
export async function createAccount(portal, { email, name, password, first = false, portalAdmin = false }) {
  const args = first ? ['account', 'create-first', '--email', email, '--name', name]
    : ['account', 'create', '--email', email, '--name', name, ...(portalAdmin ? ['--portal-admin'] : [])];
  const r = await portal.cli(args);
  if (r.code !== 0) throw new Error(`CLI ${args.slice(0, 2).join(' ')} endete mit ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  const link = r.stdout.split('\n').map((l) => l.trim()).find((l) => /^https?:\/\//.test(l));
  if (!link) throw new Error(`Kein Einrichtungslink in der CLI-Ausgabe: ${r.stdout.slice(0, 200)}`);
  const token = new URL(link).searchParams.get('token') ?? link.split('/').pop();
  const origin = new URL(portal.issuer).origin;
  const client = makePortalClient(portal.url, origin);
  const begin = await client.call('POST', '/api/auth/setup/begin', { token });
  if (!begin.ok) throw new Error(`setup/begin -> ${begin.status} ${JSON.stringify(begin.body).slice(0, 200)}`);
  const totp = makeTotp(begin.body.totpSecret);
  const done = await client.call('POST', '/api/auth/setup/complete', { token, password, code: await totp() });
  if (!done.ok) throw new Error(`setup/complete -> ${done.status} ${JSON.stringify(done.body).slice(0, 200)}`);
  return { email, name, password, totpSecret: begin.body.totpSecret, recoveryCodes: [...done.body.recoveryCodes], totp };
}

// ---------------------------------------------------------------------------
// Attrappen-Aussteller (für manipulierte ID-Tokens)
// ---------------------------------------------------------------------------
/**
 * Ein kleiner OIDC-Aussteller mit JWKS und Token-Endpunkt. `next` bestimmt, wie das nächste Token
 * aussieht (gültig oder manipuliert). Der Token-Endpunkt prüft selbst PKCE und Client-Angaben,
 * damit auch die Anfrage der Verwaltung mitgeprüft wird.
 */
export async function startFakeIssuer({ port, issuer, clientId, clientSecret }) {
  const jose = controlRequire('jose');
  const good = await jose.generateKeyPair('EdDSA', { crv: 'Ed25519' });
  const foreign = await jose.generateKeyPair('EdDSA', { crv: 'Ed25519' });
  const publicJwk = { ...(await jose.exportJWK(good.publicKey)), kid: 'k1', alg: 'EdDSA', use: 'sig' };
  const state = { next: {}, challenge: null, nonce: null, redirectUri: null, requests: [], jwksFetches: 0 };

  async function makeToken(o = {}) {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      sub: 'fake-account-1', nonce: state.nonce, auth_time: now, amr: ['pwd', 'otp'], sid: 'fake-sid-1',
      email: 'fake@example.com', name: 'Fake Konto', roles: { [clientId]: 'admin' },
      ...(o.claims ?? {}),
    };
    for (const k of o.omit ?? []) delete claims[k];
    if (o.alg === 'none') {
      const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
      const t = Math.floor(Date.now() / 1000);
      return `${b64({ alg: 'none', typ: 'JWT', kid: 'k1' })}.${b64({ ...claims, iss: issuer, aud: clientId, iat: t, exp: t + 300 })}.`;
    }
    const jwt = new jose.SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
      .setIssuer(o.iss ?? issuer)
      .setAudience(o.aud ?? clientId)
      .setIssuedAt(o.iat ?? now)
      .setExpirationTime(o.exp ?? now + 300);
    return jwt.sign(o.foreignKey ? foreign.privateKey : good.privateKey);
  }

  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/.well-known/jwks.json') {
      state.jwksFetches++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    if (path === '/oauth/token' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      const form = Object.fromEntries(new URLSearchParams(raw));
      state.requests.push(form);
      const problems = [];
      if (form.grant_type !== 'authorization_code') problems.push('grant_type');
      if (form.client_id !== clientId) problems.push('client_id');
      if (form.client_secret !== clientSecret) problems.push('client_secret');
      if (form.redirect_uri !== state.redirectUri) problems.push('redirect_uri');
      const verifierOk = typeof form.code_verifier === 'string'
        && createHash('sha256').update(form.code_verifier).digest('base64url') === state.challenge;
      if (!verifierOk) problems.push('code_verifier');
      if (problems.length) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant', problems }));
        return;
      }
      const token = await makeToken(state.next);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id_token: token, token_type: 'Bearer', expires_in: 300 }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    state,
    stop: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------
export async function launchBrowser() {
  const { chromium } = createRequire(import.meta.url)(PW_CORE);
  return chromium.launch({ executablePath: chromiumPath(), headless: true });
}

/** API-Aufruf einer Verwaltung mit den Cookies des Browser-Kontexts (CSRF per Double-Submit). */
export async function ctxApi(ctx, base, method, path, body) {
  method = method.toUpperCase();
  const headers = {};
  if (method !== 'GET') {
    const c = await ctx.request.get(`${base}/api/auth/csrf`);
    headers['x-csrf-token'] = (await c.json()).csrfToken;
  }
  const res = await ctx.request.fetch(`${base}${path}`, {
    method, headers, ...(body === undefined ? {} : { data: body }), maxRedirects: 0, failOnStatusCode: false,
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
  return { status: res.status(), ok: res.ok(), body: parsed };
}

/** Fehlercode einer Antwort der Verwaltung (verschiedene Formen). */
export function errorCode(r) {
  const b = r?.body;
  if (!b || typeof b !== 'object') return undefined;
  return b.errorCode ?? b.code ?? b.error?.code ?? (typeof b.error === 'string' ? b.error : undefined) ?? b.message?.errorCode;
}

export { ROOT, CONTROL_DIR };
export const sleepMs = sleep;
export const _dirname = dirname(fileURLToPath(import.meta.url));
