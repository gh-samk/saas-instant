// Startet die Control-API aus dem Quellcode gegen eine eigene Datenbank auf si-test-db.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docker, run } from './docker.mjs';
import { E2E_OUT, suiteDir, updateState, readState, waitFor, sleep } from './util.mjs';
import { mkdirSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..', '..');
export const CONTROL_DIR = join(ROOT, 'apps', 'control');
const require = createRequire(join(CONTROL_DIR, 'package.json'));

const DB_CONTAINER = process.env.E2E_DB_CONTAINER || 'si-test-db';
const DB_HOST = process.env.E2E_DB_HOST || '127.0.0.1';
const DB_PORT = process.env.E2E_DB_PORT || '54329';
const DB_USER = process.env.E2E_DB_USER || 'postgres';
const DB_PASS = process.env.E2E_DB_PASSWORD || 'demo';

/** Bekannte Seed-Zugangsdaten (öffentlich, nur Entwicklung; siehe prisma/seed.ts). */
export const SEED = {
  username: 'test',
  password: 'entwicklung-passwort',
  totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
};

const psql = (sql) =>
  docker(['exec', DB_CONTAINER, 'psql', '-U', DB_USER, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-tAc', sql]);

const safeName = (n) => {
  if (!/^e2e_[a-z0-9_]{1,40}$/.test(n)) throw new Error(`Datenbankname "${n}" ungültig (erwartet e2e_<name>)`);
  return n;
};

export async function createDatabase(dbName) {
  safeName(dbName);
  await psql(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await psql(`CREATE DATABASE "${dbName}"`);
  updateState((s) => { if (!s.dbs.includes(dbName)) s.dbs.push(dbName); });
}
export async function dropDatabase(dbName) {
  safeName(dbName);
  await psql(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
}
/** Löscht alle Datenbanken e2e_* (nur diese Namensfamilie) auf si-test-db. */
export async function dropAllE2eDatabases() {
  const r = await psql(`SELECT datname FROM pg_database WHERE datname LIKE 'e2e\\_%'`);
  const names = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  for (const n of names) await dropDatabase(n);
  return names;
}

const dbUrl = (dbName) => `postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${dbName}`;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * Startet die Control-API. Liefert { url, port, dbName, env, stop, login }.
 * env überschreibt die Standardumgebung (zufällige Geheimnisse je Lauf, nichts davon im Repo).
 */
export async function startControl({ port, dbName = 'e2e_control', env = {}, suite = 'control', build, vault = true } = {}) {
  port = port ?? (await freePort());
  await createDatabase(dbName);
  const logDir = suiteDir(suite);
  mkdirSync(logDir, { recursive: true });

  const childEnv = {
    ...process.env,
    DATABASE_URL: dbUrl(dbName),
    PORT: String(port),
    CONTROL_APP_URL: `http://localhost:${port}`,
    CONTROL_RP_ID: 'localhost',
    CONTROL_RP_NAME: 'saas-instant',
    JWT_SECRET: randomBytes(32).toString('hex'),
    CONTROL_CONFIG_KEY: randomBytes(32).toString('hex'),
    CONTROL_TOTP_ISSUER: 'saas-instant',
    COOKIE_SECURE: '0',
    CONTROL_TRUST_PROXY: '0',
    NODE_ENV: 'development',
    CONTROL_SEED_ALLOWED: 'ja',
    CONTROL_INSTANCE_BASE_DOMAIN: 'e2e.example.com',
    ...env,
  };

  const doBuild = build ?? (process.env.E2E_SKIP_BUILD !== '1' || !existsSync(join(CONTROL_DIR, 'dist', 'main.js')));
  if (doBuild) await run('pnpm', ['exec', 'nest', 'build'], { cwd: CONTROL_DIR, env: childEnv, timeoutMs: 600_000 });
  await run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { cwd: CONTROL_DIR, env: childEnv, timeoutMs: 300_000 });
  await run('pnpm', ['run', 'seed'], { cwd: CONTROL_DIR, env: childEnv, timeoutMs: 300_000 });

  const logPath = join(logDir, `control-${port}.log`);
  let log = null;
  let child = null;
  let exited = null;
  const launch = () => {
    exited = null;
    log = createWriteStream(logPath, { flags: 'a' });
    const c = spawn('node', ['dist/main'], {
      cwd: CONTROL_DIR, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    c.stdout.pipe(log, { end: false });
    c.stderr.pipe(log, { end: false });
    c.on('exit', (code, sig) => { if (child === c) exited = `Code ${code ?? sig}`; });
    child = c;
    updateState((s) => s.pids.push(c.pid));
  };
  const kill = async () => {
    if (!child) return;
    const c = child;
    if (exited === null) {
      try { process.kill(-c.pid, 'SIGTERM'); } catch { /* schon weg */ }
      for (let i = 0; i < 40 && exited === null; i++) await sleep(250);
      if (exited === null) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* weg */ } }
    }
    log?.end();
    updateState((s) => { s.pids = s.pids.filter((p) => p !== c.pid); });
  };
  launch();

  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    await kill();
    await dropDatabase(dbName).catch(() => {});
    updateState((s) => { s.dbs = s.dbs.filter((d) => d !== dbName); });
  };
  const waitUp = () => waitFor(async () => {
    if (exited) throw new Error(`Control-API vorzeitig beendet (${exited}); siehe ${logDir}/control-${port}.log`);
    const r = await fetch(`${url}/api/health`).catch(() => null);
    return r?.ok;
  }, { timeoutMs: Number(process.env.E2E_HEALTH_TIMEOUT_MS) || 90_000, label: '/api/health', intervalMs: 500 });
  /** Prozess beenden und mit DERSELBEN Datenbank neu starten (Tresor danach gesperrt). */
  const restart = async () => {
    await kill();
    launch();
    await waitUp();
  };

  try {
    await waitUp();
  } catch (e) {
    await stop();
    throw e;
  }

  // Nach jedem Start ist die Verwaltung gesperrt (Tresor). Einrichten und entsperren, mit einer
  // Passphrase, die es nur für diesen Lauf gibt (nie im Repo). Die dafür nötige Anmeldung wird
  // dem ERSTEN ctl.login() ohne Optionen überlassen, damit kein TOTP-Zeitfenster verbraucht wird.
  let vaultInfo = null;
  let firstLogin = null;
  if (vault) {
    try {
      const passphrase = env.E2E_VAULT_PASSPHRASE ?? `e2e-${randomBytes(18).toString('base64url')}`;
      firstLogin = await login(url);
      const setup = await firstLogin.api('POST', '/api/vault/setup', { passphrase });
      if (!setup.ok) throw new Error(`Tresor einrichten fehlgeschlagen: HTTP ${setup.status} ${JSON.stringify(setup.body).slice(0, 200)}`);
      vaultInfo = { passphrase, recoveryKey: setup.body.recoveryKey };
    } catch (e) {
      await stop();
      throw e;
    }
  }
  const loginOnce = (opts) => {
    if (!opts && firstLogin) {
      const l = firstLogin;
      firstLogin = null;
      return Promise.resolve(l);
    }
    return login(url, opts);
  };
  return { url, port, dbName, env: childEnv, stop, restart, vault: vaultInfo, login: loginOnce };
}

export const stopControl = (ctl) => ctl.stop();

/** Cookie-Speicher + Anfrage-Client. */
export function makeClient(base) {
  const jar = new Map();
  let csrf = null;
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const absorb = (res) => {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = line.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0/i.test(a)) || value === '';
      if (expired) jar.delete(name); else jar.set(name, decodeURIComponent(value));
      if (name === 'csrf') csrf = decodeURIComponent(value);
    }
  };
  /** api(method, path, body) -> { status, ok, body } (wirft nicht bei HTTP-Fehlern). */
  async function api(method, path, body, { headers = {}, raw = false } = {}) {
    method = method.toUpperCase();
    const h = { ...headers };
    if (body !== undefined && !(body instanceof Uint8Array) && typeof body !== 'string') h['content-type'] = 'application/json';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      if (!csrf) {
        const r = await fetch(`${base}/api/auth/csrf`, { headers: { cookie: cookieHeader() } });
        absorb(r);
        csrf = (await r.json()).csrfToken;
      }
      h['x-csrf-token'] = csrf;
    }
    if (jar.size) h.cookie = cookieHeader();
    const res = await fetch(`${base}${path}`, {
      method, headers: h,
      body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
    });
    absorb(res);
    let parsed;
    if (raw) parsed = Buffer.from(await res.arrayBuffer());
    else {
      const text = await res.text();
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    }
    return { status: res.status, ok: res.ok, headers: res.headers, body: parsed };
  }
  return { api, jar };
}

/**
 * Meldet den Seed-Benutzer mit Passwort + TOTP an.
 * Liefert { api, proof, user }:
 *  - api(method, path, body): Client mit Cookies/CSRF
 *  - proof(): { totpCode } — für SecondFactorGuard-Routen in den Body mischen
 *    (ein bereits benutzter TOTP-Schritt wird nicht erneut verwendet: ggf. Warten bis zum nächsten 30-s-Fenster).
 */
export async function login(base, { username = SEED.username, password = SEED.password, totpSecret = SEED.totpSecret } = {}) {
  const { authenticator } = require('otplib');
  const { api } = makeClient(base);
  let lastStep = -1;
  const nextCode = async () => {
    for (;;) {
      const step = Math.floor(Date.now() / 30_000);
      if (step !== lastStep) {
        lastStep = step;
        return authenticator.generate(totpSecret);
      }
      await sleep(30_000 - (Date.now() % 30_000) + 200);
    }
  };
  const first = await api('POST', '/api/auth/login', { identifier: username, password });
  if (!first.ok) throw new Error(`Login fehlgeschlagen: HTTP ${first.status} ${JSON.stringify(first.body).slice(0, 200)}`);
  let user = first.body?.user;
  if (first.body?.secondFactorRequired) {
    const second = await api('POST', '/api/auth/login/totp', { code: await nextCode() });
    if (!second.ok) throw new Error(`TOTP-Anmeldung fehlgeschlagen: HTTP ${second.status} ${JSON.stringify(second.body).slice(0, 200)}`);
    user = second.body.user;
  }
  const proof = async () => ({ totpCode: await nextCode() });
  return { api, proof, user };
}
