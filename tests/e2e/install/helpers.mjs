// Hilfen der Suite install: Docker-Shim (Label e2e=true), Repo-Kopie, Browser, HTTP-Client.
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { run, docker } from '../lib/docker.mjs';
import { E2E_OUT, waitFor } from '../lib/util.mjs';
import { ROOT } from '../lib/control.mjs';

export const OUT = join(E2E_OUT, 'install');
export const PW_CORE = 'playwright-core';

/** Fehler, die ein Verhalten des PRODUKTS betreffen (nicht des Skripts). */
export function expect(cond, msg) {
  if (!cond) throw new Error(`PRODUKT: ${msg}`);
}

export async function freePortFrom(start) {
  for (let p = start; p < start + 200; p++) {
    const ok = await new Promise((res) => {
      const s = createServer();
      s.once('error', () => res(false));
      s.listen(p, '0.0.0.0', () => s.close(() => res(true)));
    });
    if (ok) return p;
  }
  throw new Error(`Kein freier Port ab ${start}`);
}

// ---------------------------------------------------------------------------
// Docker-Shim: setzt an jeden 'docker compose'-Aufruf eine Override-Datei, die allen
// Diensten, Volumes und Netzen das Label e2e=true gibt. So bleibt install.sh unverändert.
// ---------------------------------------------------------------------------
export function writeShim() {
  const dir = join(OUT, 'shim');
  mkdirSync(dir, { recursive: true });
  const real = '/usr/local/bin/docker';
  const script = `#!/bin/bash
REAL="${real}"
if [ "\${1:-}" = compose ]; then
  args=("$@"); last=-1; portal=0
  for ((i=0;i<\${#args[@]};i++)); do
    if [ "\${args[$i]}" = "-f" ]; then
      last=$i
      case "\${args[$((i+1))]:-}" in *docker-compose.portal.yml) portal=1 ;; esac
    fi
  done
  ovr="\${E2E_OVR_CONTROL:-}"
  [ "$portal" = 1 ] && ovr="\${E2E_OVR_PORTAL:-}"
  if [ "$last" -ge 0 ] && [ -n "$ovr" ]; then
    new=("\${args[@]:0:$((last+2))}" -f "$ovr" "\${args[@]:$((last+2))}")
    exec "$REAL" "\${new[@]}"
  fi
fi
exec "$REAL" "$@"
`;
  writeFileSync(join(dir, 'docker'), script);
  chmodSync(join(dir, 'docker'), 0o755);
  return dir;
}

const LBL = '{ labels: { e2e: "true", "e2e.suite": "install" } }';
export function controlOverride({ caddyfile, caddyPort } = {}) {
  const svc = ['control-db', 'control-api', 'invoice-renderer', 'backup-agent', 'docker-socket-proxy', 'control-web'];
  let y = 'services:\n' + svc.map((s) => `  ${s}: ${LBL}\n`).join('');
  if (caddyfile) {
    y += `  caddy:
    image: caddy:2-alpine
    labels: { e2e: "true", "e2e.suite": "install" }
    ports:
      - "127.0.0.1:${caddyPort}:${caddyPort}"
    volumes:
      - ${caddyfile}:/etc/caddy/Caddyfile:ro
    depends_on:
      - control-web
`;
  }
  y += `volumes:\n  control-db-data: ${LBL}\n  backup-agent-state: ${LBL}\nnetworks:\n  default: ${LBL}\n  docker-api: ${LBL}\n`;
  return y;
}
export const portalOverride = () => `services:\n  portal: ${LBL}\nnetworks:\n  default: ${LBL}\n`;

/** Kopiert den Quellbaum (ohne node_modules, Builds, Betriebsdaten) in ein frisches Verzeichnis. */
export async function copyRepo(dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const ex = ['/.git', 'node_modules', 'dist', 'dist-web', '/installations', '/portal', '/.saas-instant-mode', '/tests', '/docs/screenshots', '.DS_Store', '*.log', '*.tsbuildinfo', '/backups', '.env', '.env.*'];
  // '.env.example' soll mit: --include muss vor den --exclude stehen
  const a2 = ['-a', '--include', '.env.example', ...ex.flatMap((e) => ['--exclude', e]), `${ROOT}/`, `${dest}/`];
  await run('rsync', a2);
}

export function parseEnv(file) {
  const o = {};
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l);
    if (m) o[m[1]] = m[2];
  }
  return o;
}
export function setEnvLine(file, key, value) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let hit = false;
  const out = lines.map((l) => (l.startsWith(`${key}=`) ? ((hit = true), `${key}=${value}`) : l));
  if (!hit) out.push(`${key}=${value}`);
  writeFileSync(file, out.join('\n'));
}
export const modeOf = (f) => (statSync(f).mode & 0o777).toString(8);

// ---------------------------------------------------------------------------
// Docker-Abfragen
// ---------------------------------------------------------------------------
export async function containersOf(project) {
  const r = await docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}|{{.Label "com.docker.compose.service"}}|{{.Names}}'], { allowFail: true });
  return r.stdout.split('\n').filter(Boolean).map((l) => {
    const [id, service, name] = l.split('|');
    return { id, service, name };
  });
}
export async function inspect(id) {
  const r = await docker(['inspect', id]);
  return JSON.parse(r.stdout)[0];
}
export async function stateOf(project, service) {
  const c = (await containersOf(project)).find((x) => x.service === service);
  if (!c) return null;
  const i = await inspect(c.id);
  return { id: c.id, name: c.name, status: i.State.Status, health: i.State.Health?.Status ?? null, restarts: i.RestartCount, exitCode: i.State.ExitCode, info: i };
}
export async function serviceLogs(project, service, tail = 200) {
  const c = (await containersOf(project)).find((x) => x.service === service);
  if (!c) return '';
  const r = await docker(['logs', '--tail', String(tail), c.id], { allowFail: true });
  return `${r.stdout}${r.stderr}`;
}

const WANT = { 'control-db': 'healthy', 'control-api': 'healthy', 'control-web': 'running' };
export const WANT_ALL = { ...WANT, 'invoice-renderer': 'running', 'backup-agent': 'running', 'docker-socket-proxy': 'running' };
/** Wartet, bis alle Dienste des Control-Stacks laufen (mit Healthcheck: healthy) und /api/health über den Web-Port antwortet. */
export async function waitStack(project, port, { timeoutMs = 360_000 } = {}) {
  let last = '';
  await waitFor(async () => {
    const bad = [];
    for (const [svc, want] of Object.entries(WANT)) {
      const s = await stateOf(project, svc);
      const ok = s && (want === 'healthy' ? s.health === 'healthy' : s.status === 'running' && (s.health === null || s.health === 'healthy'));
      if (!ok) bad.push(`${svc}:${s ? `${s.status}/${s.health}` : 'fehlt'}`);
    }
    last = bad.join(' ');
    if (bad.length) return false;
    const r = await get(`http://127.0.0.1:${port}/api/health`).catch(() => null);
    return r?.status === 200;
  }, { timeoutMs, intervalMs: 2000, label: `Stack ${project} bereit (${last})` }).catch((e) => {
    throw new Error(`${e.message} [${last}]`);
  });
}

export async function composeLogs(project) {
  const parts = [];
  for (const c of await containersOf(project)) {
    const r = await docker(['logs', '--tail', '400', c.id], { allowFail: true });
    parts.push(`===== ${c.service} (${c.name}) =====\n${r.stdout}${r.stderr}`);
  }
  return parts.join('\n').replace(/token=[A-Za-z0-9_-]+/g, 'token=<maskiert>');
}

// ---------------------------------------------------------------------------
// HTTP (http und https mit selbstsigniertem Zertifikat), Cookies
// ---------------------------------------------------------------------------
export function httpCall(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { ...headers };
    if (data !== undefined && typeof body !== 'string') h['content-type'] = 'application/json';
    const req = lib(u, { method, headers: h, rejectUnauthorized: false, timeout: 20_000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* kein JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, setCookie: res.headers['set-cookie'] ?? [], text, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Zeitüberschreitung ${method} ${url}`)));
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}
export const get = (url, o) => httpCall('GET', url, o);

// ---------------------------------------------------------------------------
// Browser (playwright-core aus dem Schwesterprojekt, Chromium aus dem Playwright-Cache)
// ---------------------------------------------------------------------------
export function chromiumPath() {
  const base = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  const dirs = readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    const p = join(base, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    if (existsSync(p)) return p;
  }
  throw new Error('Chromium im Playwright-Cache nicht gefunden');
}

export async function withBrowser(fn, { ignoreHTTPSErrors = false } = {}) {
  const { chromium } = createRequire(import.meta.url)(PW_CORE);
  const browser = await chromium.launch({ executablePath: chromiumPath(), headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'de-DE', ignoreHTTPSErrors });
    const page = await ctx.newPage();
    return await fn(page, ctx);
  } finally {
    await browser.close();
  }
}

/** Öffnet die Anmeldeseite und liefert Seitentext + Titel (wartet, bis die Oberfläche gerendert hat). */
export async function loginPage(page, base, expectText) {
  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction((t) => document.body.innerText.includes(t) || document.title.includes(t), expectText, { timeout: 20_000 }).catch(() => {});
  const text = await page.evaluate(() => document.body.innerText);
  return { text, title: await page.title() };
}

/** Prüft, ob ALLE Dienste des Stacks laufen (kein Neustart, keine Schleife). Liefert Fehlerliste. */
export async function stackProblems(project) {
  const bad = [];
  for (const [svc, want] of Object.entries(WANT_ALL)) {
    const st = await stateOf(project, svc);
    const ok = st && st.status === 'running' && st.restarts === 0 && (want !== 'healthy' || st.health === 'healthy');
    if (!ok) bad.push(`${svc}: ${st ? `${st.status}, Neustarts ${st.restarts}, Health ${st.health}` : 'fehlt'}`);
  }
  return bad;
}
