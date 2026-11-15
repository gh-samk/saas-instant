// Suite install – Echttest der Installation mit echten Containern.
// Ablauf siehe README (tests/e2e). Alles liegt unter ${E2E_OUT}/install/, Projekte heißen saas-instant-e2e-*,
// alle Container/Volumes/Netze tragen das Label e2e=true (Docker-Shim + Override-Datei, install.sh bleibt unverändert).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createSuite, assert, sleep, waitFor } from '../lib/util.mjs';
import { docker, run, cleanup } from '../lib/docker.mjs';
import {
  OUT, expect, freePortFrom, writeShim, controlOverride, portalOverride, copyRepo, parseEnv, setEnvLine, modeOf,
  containersOf, inspect, stateOf, stackProblems, serviceLogs, waitStack, composeLogs, httpCall, get, withBrowser, loginPage,
} from './helpers.mjs';

const s = createSuite('install');
const STEP_LONG = { timeoutMs: 1_500_000 };
const STEP_MID = { timeoutMs: 400_000 };
const productBugs = [];
mkdirSync(OUT, { recursive: true });
const shim = writeShim();

/** Eine Installation (Zielverzeichnis, Umgebung, Override). */
function makeCtx(dirName, { caddy } = {}) {
  const dir = join(OUT, dirName);
  const ovrControl = join(OUT, `${dirName}.override.yml`);
  const ovrPortal = join(OUT, `${dirName}.override.portal.yml`);
  const caddyfile = join(OUT, `${dirName}.Caddyfile`);
  if (caddy) {
    writeFileSync(caddyfile, `{\n  admin off\n  auto_https disable_redirects\n  skip_install_trust\n}\nhttps://localhost:${caddy.port} {\n  tls internal\n  reverse_proxy control-web:80\n}\n`);
  }
  writeFileSync(ovrControl, controlOverride(caddy ? { caddyfile, caddyPort: caddy.port } : {}));
  writeFileSync(ovrPortal, portalOverride());
  const env = { ...process.env, PATH: `${shim}:${process.env.PATH}`, E2E_OVR_CONTROL: ovrControl, E2E_OVR_PORTAL: ovrPortal };
  const log = join(OUT, `${dirName}.log`);
  writeFileSync(log, '');
  return { dirName, dir, env, ovrControl, ovrPortal, log, projects: new Set(), slugs: [] };
}
const note = (ctx, text) => appendFileSync(ctx.log, `${text.replace(/token=[A-Za-z0-9_-]+/g, 'token=<maskiert>')}\n`);

/** Führt ein Skript des Zielverzeichnisses aus; schreibt Ausgabe (ohne Token) ins Logbuch. */
async function sh(ctx, script, args, { allowFail = true, timeoutMs = 1_500_000 } = {}) {
  const r = await run('bash', [join(ctx.dir, script), ...args], { cwd: ctx.dir, env: ctx.env, allowFail, timeoutMs });
  note(ctx, `$ ${script} ${args.join(' ')}\n[exit ${r.code}]\n${r.stdout}${r.stderr}`);
  return r;
}
const install = (ctx, args, o) => sh(ctx, 'install.sh', args, o);
const cli = (ctx, args, o) => sh(ctx, 'bin/saas-instant', args, o);
const envFile = (ctx, slug) => join(ctx.dir, 'installations', slug, '.env');
const projectOf = (slug) => `saas-instant-${slug}`;

async function teardown(ctx) {
  for (const slug of ctx.slugs) {
    const ef = envFile(ctx, slug);
    if (existsSync(ef)) {
      const project = projectOf(slug);
      await composeLogs(project).then((t) => writeFileSync(join(OUT, `${ctx.dirName}-${slug}.containers.log`), t)).catch(() => {});
      await docker(['compose', '--project-directory', ctx.dir, '--env-file', ef, '-f', join(ctx.dir, 'docker-compose.yml'), '-f', ctx.ovrControl, 'down', '-v', '--remove-orphans', '--rmi', 'local'], { allowFail: true, env: ctx.env, timeoutMs: 300_000 });
    }
  }
  const pe = join(ctx.dir, 'portal', 'portal.env');
  if (existsSync(pe)) {
    await composeLogs('saas-instant-e2e-portal').then((t) => writeFileSync(join(OUT, `${ctx.dirName}-portal.containers.log`), t)).catch(() => {});
    await docker(['compose', '--env-file', pe, '-f', join(ctx.dir, 'apps/portal/docker-compose.portal.yml'), '-f', ctx.ovrPortal, 'down', '-v', '--remove-orphans', '--rmi', 'local'], { allowFail: true, env: ctx.env, timeoutMs: 300_000 });
  }
}

const needed = (v, what) => { if (!v) throw new Error(`übersprungen: ${what} fehlt (früherer Schritt gescheitert)`); return v; };
const firstUrl = (text) => /https?:\/\/\S+/.exec(text)?.[0];

/** Hilfsprüfungen, die in mehreren Szenarien laufen. */
async function checkPortsLoopback(projects) {
  const bad = [];
  for (const p of projects) {
    for (const c of await containersOf(p)) {
      const i = await inspect(c.id);
      const b = i.HostConfig.PortBindings ?? {};
      for (const [cp, arr] of Object.entries(b)) for (const h of arr ?? []) if (h.HostIp !== '127.0.0.1') bad.push(`${c.service} ${cp} -> ${h.HostIp || '0.0.0.0'}:${h.HostPort}`);
    }
  }
  return bad;
}
async function checkNoPublished(project, services) {
  for (const svc of services) {
    const st = await stateOf(project, svc);
    expect(st, `Dienst ${svc} fehlt`);
    const pb = st.info.HostConfig.PortBindings ?? {};
    expect(Object.keys(pb).length === 0, `${svc} veröffentlicht Ports: ${JSON.stringify(pb)}`);
    const live = Object.values(st.info.NetworkSettings.Ports ?? {}).filter((v) => v && v.length);
    expect(live.length === 0, `${svc} hat Host-Ports: ${JSON.stringify(st.info.NetworkSettings.Ports)}`);
  }
}
function secretsIn(inspectJson, envObj) {
  const keys = ['JWT_SECRET', 'CONTROL_CONFIG_KEY', 'CONTROL_POSTGRES_PASSWORD', 'BACKUP_AGENT_SECRET', 'AGENT_STATE_KEY', 'BACKUP_REPORT_KEY'];
  const text = JSON.stringify(inspectJson);
  return keys.filter((k) => envObj[k] && text.includes(envObj[k]));
}

// ===========================================================================
// Szenario A: Modus single mit --name (Schritte 1, 2, 5 und Abgrenzung zu Portal)
// ===========================================================================
async function scenarioSingle() {
  const ctx = makeCtx('single');
  const slug = 'e2e-shop';
  const project = projectOf(slug);
  ctx.slugs.push(slug);
  let port;
  let env;
  try {
    await s.step('1a single: install.sh startet den Stack (Name "Shop Software")', async () => {
      await copyRepo(ctx.dir);
      const r = await install(ctx, ['--mode', 'single', '--software', slug, '--name', 'Shop Software', '--non-interactive', '--yes']);
      assert(r.code === 0, `install.sh Exit ${r.code}: ${(r.stderr || r.stdout).trim().split('\n').slice(-4).join(' | ')}`);
      env = parseEnv(envFile(ctx, slug));
      port = Number(env.CONTROL_WEB_PORT);
      assert(port > 0, 'CONTROL_WEB_PORT fehlt in .env');
      expect(env.COMPOSE_PROJECT_NAME === project, `COMPOSE_PROJECT_NAME ${env.COMPOSE_PROJECT_NAME}`);
      const lock = readFileSync(join(ctx.dir, '.saas-instant-mode'), 'utf8');
      expect(/^mode=single$/m.test(lock), `Modus-Lock: ${lock.trim()}`);
    }, STEP_LONG);

    await s.step('1b single: alle Dienste healthy, /api/health über den Web-Port', async () => {
      await waitStack(project, needed(port, 'Port'));
    }, { timeoutMs: 420_000 });

    await s.step('1b2 single: auch Rechnungsdienst, Backup-Agent und Docker-Proxy laufen stabil (keine Neustartschleife)', async () => {
      await sleep(15_000);
      const bad = await stackProblems(project);
      if (bad.length) note(ctx, `Dienste mit Problem: ${bad.join(' | ')}\n${await serviceLogs(project, 'docker-socket-proxy', 5)}`);
      expect(bad.length === 0, `Dienste laufen nicht stabil: ${bad.join(' | ')}`);
    }, { timeoutMs: 120_000 });

    await s.step('1c single: /api/public-config liefert productName "Shop Software" und bound=true', async () => {
      const r = await get(`http://127.0.0.1:${needed(port, 'Port')}/api/public-config`);
      expect(r.status === 200, `HTTP ${r.status}`);
      expect(r.json?.productName === 'Shop Software', `productName = ${JSON.stringify(r.json?.productName)}`);
      expect(r.json?.bound === true, `bound = ${r.json?.bound}`);
    });

    await s.step('1d single: Anmeldeseite (Browser) zeigt "Shop Software"', async () => {
      await withBrowser(async (page) => {
        const { text, title } = await loginPage(page, `http://127.0.0.1:${needed(port, 'Port')}`, 'Shop Software');
        await page.screenshot({ path: join(OUT, 'single-login.png') });
        expect(text.includes('Shop Software') || title.includes('Shop Software'), `Seitentext/Titel ohne "Shop Software": "${title}" / "${text.slice(0, 160).replace(/\n/g, ' ')}"`);
      });
    });

    await s.step('1e single: emergency first-account liefert Link mit Token', async () => {
      const r = await cli(ctx, ['emergency', slug, 'first-account', 'erstkonto@e2e.test', 'E2E', 'Erstkonto']);
      assert(r.code === 0, `Exit ${r.code}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}`);
      const link = firstUrl(r.stdout);
      expect(link && /token=[A-Za-z0-9_-]{16,}/.test(link), 'kein Link mit Token in der Ausgabe');
      expect(link.startsWith(env.CONTROL_APP_URL), `Link beginnt nicht mit CONTROL_APP_URL: ${link.split('?')[0]}`);
      // Zweites Erstkonto muss scheitern.
      const r2 = await cli(ctx, ['emergency', slug, 'first-account', 'zweites@e2e.test', 'Zweites', 'Konto']);
      expect(r2.code !== 0, 'ein zweites Erstkonto wurde angelegt');
    }, STEP_MID);

    // ---- (2) Bindung -------------------------------------------------------
    await s.step('2a Bindung: abweichender Slug in der Umgebung -> control-api startet NICHT', async () => {
      const ef = envFile(ctx, slug);
      setEnvLine(ef, 'SAAS_INSTANT_SLUG', 'e2e-anderes-produkt');
      const r = await cli(ctx, ['up', slug]);
      note(ctx, `up mit falschem Slug: exit ${r.code}`);
      const st = await waitFor(async () => {
        const x = await stateOf(project, 'control-api');
        return x && (x.status === 'restarting' || x.status === 'exited' || x.restarts >= 1) ? x : null;
      }, { timeoutMs: 120_000, intervalMs: 2000, label: 'control-api in Neustartschleife/beendet' });
      const lg = await waitFor(async () => {
        const t = await serviceLogs(project, 'control-api', 300);
        return t.includes('Slug passt nicht') ? t : null;
      }, { timeoutMs: 60_000, intervalMs: 2000, label: 'Log nennt die Abweichung' });
      expect(/e2e-anderes-produkt/.test(lg) && /e2e-shop/.test(lg), 'Log nennt die Slugs nicht');
      const h = await get(`http://127.0.0.1:${port}/api/health`).catch(() => ({ status: 0 }));
      expect(h.status !== 200, `/api/health antwortet trotz Slug-Abweichung mit 200 (Zustand ${st.status})`);
    }, STEP_MID);

    await s.step('2b Bindung: Slug zurück -> control-api startet wieder', async () => {
      setEnvLine(envFile(ctx, slug), 'SAAS_INSTANT_SLUG', slug);
      const r = await cli(ctx, ['up', slug]);
      assert(r.code === 0, `up Exit ${r.code}`);
      await waitStack(project, port, { timeoutMs: 300_000 });
      const c = await get(`http://127.0.0.1:${port}/api/public-config`);
      expect(c.json?.productName === 'Shop Software' && c.json?.bound === true, 'public-config nach Neustart: ' + c.text.slice(0, 120));
    }, STEP_MID);

    // ---- Modus-Grenzen -----------------------------------------------------
    await s.step('3a single: "bin/saas-instant add" scheitert', async () => {
      const r = await cli(ctx, ['add', 'e2e-zusatz']);
      expect(r.code !== 0, 'add im Modus single wurde angenommen');
      expect(/portal/i.test(r.stderr + r.stdout), 'Meldung nennt den Modus portal nicht');
      expect(!existsSync(join(ctx.dir, 'installations', 'e2e-zusatz')), 'Verzeichnis für die Zusatz-Verwaltung entstand trotzdem');
    });
    await s.step('3b single: Moduswechsel auf portal wird abgelehnt', async () => {
      const r = await install(ctx, ['--mode', 'portal', '--software', 'e2e-portalwechsel', '--non-interactive', '--yes']);
      expect(r.code !== 0, 'install.sh --mode portal wurde nach single akzeptiert');
      expect(/festgelegt/.test(r.stderr + r.stdout), 'Meldung nennt die Festlegung nicht: ' + (r.stderr || r.stdout).trim().slice(0, 120));
      expect(!existsSync(join(ctx.dir, 'installations', 'e2e-portalwechsel')) && !existsSync(join(ctx.dir, 'portal', 'registry.json')), 'es wurde trotz Ablehnung etwas angelegt');
      expect(/^mode=single$/m.test(readFileSync(join(ctx.dir, '.saas-instant-mode'), 'utf8')), 'Modus-Lock verändert');
    });
    await s.step('3c single: zweite Verwaltung im Modus single wird abgelehnt', async () => {
      const r = await install(ctx, ['--mode', 'single', '--software', 'e2e-zweite', '--non-interactive', '--yes']);
      expect(r.code !== 0, 'zweite Verwaltung im Modus single angelegt');
      expect(!existsSync(join(ctx.dir, 'installations', 'e2e-zweite')), 'Verzeichnis der zweiten Verwaltung entstand');
    });

    // ---- (5) Härtung -------------------------------------------------------
    await s.step('5a Härtung: veröffentlichte Ports nur an 127.0.0.1', async () => {
      const bad = await checkPortsLoopback([project]);
      expect(bad.length === 0, `nicht an Loopback gebunden: ${bad.join('; ')}`);
      const web = await stateOf(project, 'control-web');
      expect(Object.keys(web.info.HostConfig.PortBindings ?? {}).length >= 1, 'control-web veröffentlicht keinen Port');
    });
    await s.step('5b Härtung: .env hat Rechte 600', async () => {
      const m = modeOf(envFile(ctx, slug));
      expect(m === '600', `Rechte der .env: ${m}`);
    });
    await s.step('5c Härtung: keine Geheimnisse in docker inspect von control-web/invoice-renderer/docker-socket-proxy', async () => {
      const e = parseEnv(envFile(ctx, slug));
      const leaks = [];
      for (const svc of ['control-web', 'invoice-renderer', 'docker-socket-proxy']) {
        const st = await stateOf(project, svc);
        expect(st, `Dienst ${svc} fehlt`);
        for (const k of secretsIn(st.info, e)) leaks.push(`${svc}:${k}`);
      }
      expect(leaks.length === 0, `Geheimnisse in docker inspect: ${leaks.join(', ')}`);
      // Gegenprobe: das Prüfverfahren findet Geheimnisse dort, wo sie sein dürfen.
      const api = await stateOf(project, 'control-api');
      assert(secretsIn(api.info, e).length >= 3, 'Gegenprobe: control-api zeigt keine Geheimnisse – Prüfung wäre blind');
    });
    await s.step('5d Härtung: Backup-Agent und Docker-Proxy ohne veröffentlichten Port, Proxy nur im internen Netz', async () => {
      await checkNoPublished(project, ['backup-agent', 'docker-socket-proxy', 'control-api', 'control-db', 'invoice-renderer']);
      const px = await stateOf(project, 'docker-socket-proxy');
      const nets = Object.keys(px.info.NetworkSettings.Networks);
      expect(nets.length === 1 && nets[0].endsWith('docker-api'), `Docker-Proxy hängt in Netzen: ${nets.join(', ')}`);
      const net = JSON.parse((await docker(['network', 'inspect', nets[0]])).stdout)[0];
      expect(net.Internal === true, 'Netz des Docker-Proxys ist nicht intern');
      const ba = await stateOf(project, 'backup-agent');
      expect(ba.info.HostConfig.ReadonlyRootfs === true, 'backup-agent: Root-Dateisystem nicht schreibgeschützt');
      const mounts = JSON.stringify(px.info.Mounts);
      expect(/docker\.sock/.test(mounts) && px.info.Mounts.every((m) => m.RW === false), 'Docker-Socket nicht schreibgeschützt eingebunden');
    });
    await s.step('5e Härtung: control-web liefert Sicherheits-Kopfzeilen (CSP, nosniff)', async () => {
      const r = await get(`http://127.0.0.1:${port}/`);
      expect(r.status === 200, `HTTP ${r.status}`);
      expect(r.headers['content-security-policy'], 'Content-Security-Policy fehlt auf control-web');
      expect(String(r.headers['x-content-type-options']).toLowerCase() === 'nosniff', 'X-Content-Type-Options fehlt');
    });
  } finally {
    await teardown(ctx);
  }
}

// ===========================================================================
// Szenario B: ohne --name -> "SAAS Verwaltung"
// ===========================================================================
async function scenarioPlain() {
  const ctx = makeCtx('plain');
  const slug = 'e2e-plain';
  const project = projectOf(slug);
  ctx.slugs.push(slug);
  let port;
  try {
    await s.step('1f plain: Installation ohne --name startet', async () => {
      await copyRepo(ctx.dir);
      const r = await install(ctx, ['--mode', 'single', '--software', slug, '--non-interactive', '--yes']);
      assert(r.code === 0, `install.sh Exit ${r.code}: ${(r.stderr || r.stdout).trim().split('\n').slice(-4).join(' | ')}`);
      port = Number(parseEnv(envFile(ctx, slug)).CONTROL_WEB_PORT);
      await waitStack(project, port);
    }, STEP_LONG);
    await s.step('1g plain: Anmeldeseite zeigt "SAAS Verwaltung" (ohne --name)', async () => {
      const pc = await get(`http://127.0.0.1:${needed(port, 'Port')}/api/public-config`);
      note(ctx, `public-config: ${pc.text}`);
      await withBrowser(async (page) => {
        const { text, title } = await loginPage(page, `http://127.0.0.1:${port}`, 'SAAS Verwaltung');
        await page.screenshot({ path: join(OUT, 'plain-login.png') });
        expect(text.includes('SAAS Verwaltung') || title.includes('SAAS Verwaltung'),
          `Anmeldeseite ohne --name zeigt nicht "SAAS Verwaltung" (public-config: ${pc.text.slice(0, 100)}; Titel "${title}")`);
      });
    });
  } finally {
    await teardown(ctx);
  }
}

// ===========================================================================
// Szenario C: Modus portal (alpha + add beta, Portal-Container, Browser)
// ===========================================================================
function manifestFor(ctx, slug, name) {
  const ex = readFileSync(join(ctx.dir, 'saas-instant.manifest.example.yaml'), 'utf8').split('\n');
  let inProduct = false;
  const out = ex.map((l) => {
    if (/^product:/.test(l)) { inProduct = true; return l; }
    if (/^[^ \t#]/.test(l)) inProduct = false;
    if (inProduct && /^\s+slug:/.test(l)) return l.replace(/slug:.*/, `slug: ${slug}`);
    if (inProduct && /^\s+name:/.test(l)) return l.replace(/name:.*/, `name: "${name}"`);
    return l;
  });
  return out.join('\n');
}

async function scenarioPortal() {
  const ctx = makeCtx('portal');
  const alpha = 'e2e-alpha';
  const beta = 'e2e-beta';
  ctx.slugs.push(alpha, beta);
  const portalProject = 'saas-instant-e2e-portal';
  let pa;
  let pb;
  let pp;
  try {
    await s.step('4a portal: install.sh --mode portal (alpha) startet Verwaltung und Portal', async () => {
      await copyRepo(ctx.dir);
      pp = await freePortFrom(18090);
      mkdirSync(join(ctx.dir, 'portal'), { recursive: true });
      writeFileSync(join(ctx.dir, 'portal', 'portal.env'), `COMPOSE_PROJECT_NAME=${portalProject}\nPORTAL_PORT=${pp}\n`);
      const r = await install(ctx, ['--mode', 'portal', '--software', alpha, '--name', 'Alpha Verwaltung', '--non-interactive', '--yes']);
      assert(r.code === 0, `install.sh Exit ${r.code}: ${(r.stderr || r.stdout).trim().split('\n').slice(-4).join(' | ')}`);
      pa = Number(parseEnv(envFile(ctx, alpha)).CONTROL_WEB_PORT);
      expect(/^mode=portal$/m.test(readFileSync(join(ctx.dir, '.saas-instant-mode'), 'utf8')), 'Modus-Lock nicht portal');
    }, STEP_LONG);
    await s.step('4b portal: bin/saas-instant add beta startet zweite Verwaltung', async () => {
      // Anzeigename von beta über ein vorab angelegtes Manifest (add kennt keine --name-Option).
      mkdirSync(join(ctx.dir, 'installations', beta), { recursive: true });
      writeFileSync(join(ctx.dir, 'installations', beta, 'saas-instant.manifest.yaml'), manifestFor(ctx, beta, 'Beta Verwaltung'));
      const r = await cli(ctx, ['add', beta]);
      assert(r.code === 0, `add Exit ${r.code}: ${(r.stderr || r.stdout).trim().split('\n').slice(-4).join(' | ')}`);
      pb = Number(parseEnv(envFile(ctx, beta)).CONTROL_WEB_PORT);
      expect(pa !== pb && pb > 0, `Ports von alpha und beta gleich (${pa}/${pb})`);
    }, STEP_LONG);
    await s.step('4c portal: beide Verwaltungen laufen gleichzeitig healthy, je eigener Name', async () => {
      await waitStack(projectOf(alpha), needed(pa, 'Port alpha'));
      await waitStack(projectOf(beta), needed(pb, 'Port beta'));
      const a = await get(`http://127.0.0.1:${pa}/api/public-config`);
      const b = await get(`http://127.0.0.1:${pb}/api/public-config`);
      expect(a.json?.productName === 'Alpha Verwaltung' && a.json?.bound === true, `alpha public-config: ${a.text.slice(0, 120)}`);
      expect(b.json?.productName === 'Beta Verwaltung' && b.json?.bound === true, `beta public-config: ${b.text.slice(0, 120)}`);
    }, { timeoutMs: 600_000 });
    await s.step('4d portal: Portal-Container liefert registry.json mit beiden Namen', async () => {
      const reg = JSON.parse(readFileSync(join(ctx.dir, 'portal', 'registry.json'), 'utf8'));
      const names = reg.entries.map((e) => e.name);
      expect(names.includes('Alpha Verwaltung') && names.includes('Beta Verwaltung'), `registry.json (Datei): ${names.join(', ')}`);
      await waitFor(async () => (await stateOf(portalProject, 'portal'))?.status === 'running', { timeoutMs: 120_000, label: 'Portal-Container läuft' });
      const r = await waitFor(async () => { const x = await get(`http://127.0.0.1:${needed(pp, 'Portal-Port')}/registry.json`).catch(() => null); return x?.status === 200 ? x : null; }, { timeoutMs: 60_000, label: 'Portal liefert registry.json' });
      const served = r.json?.entries?.map((e) => e.name) ?? [];
      expect(served.includes('Alpha Verwaltung') && served.includes('Beta Verwaltung'), `ausgeliefert: ${served.join(', ')}`);
    });
    await s.step('4d2 portal: Startseite unter / wird ausgeliefert (200) und Container ist healthy', async () => {
      const r = await get(`http://127.0.0.1:${needed(pp, 'Portal-Port')}/`);
      const st = await stateOf(portalProject, 'portal');
      expect(r.status === 200 && /<title>/i.test(r.text), `GET / liefert HTTP ${r.status} (GET /index.html: ${(await get(`http://127.0.0.1:${pp}/index.html`)).status}); Container-Health: ${st?.health}`);
      expect(st.health === 'healthy', `Portal-Container nicht healthy: ${st.health}`);
    });
    await s.step('4e portal: Browser zeigt zwei Karten, "Öffnen" erreicht jeweils die richtige Verwaltung', async () => {
      await withBrowser(async (page) => {
        // Bewusst /index.html: die Kartenlogik wird auch geprüft, wenn / (siehe 4d2) nicht ausliefert.
        const base = `http://127.0.0.1:${needed(pp, 'Portal-Port')}/index.html`;
        await page.goto(base, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('li.karte', { timeout: 20_000 });
        await page.screenshot({ path: join(OUT, 'portal-karten.png') });
        const n = await page.locator('li.karte').count();
        expect(n === 2, `Karten im Portal: ${n}`);
        for (const [name, port] of [['Alpha Verwaltung', pa], ['Beta Verwaltung', pb]]) {
          await page.goto(base, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('li.karte');
          const card = page.locator('li.karte', { hasText: name });
          expect(await card.count() === 1, `Karte "${name}" fehlt`);
          await Promise.all([page.waitForURL((u) => u.port === String(port), { timeout: 20_000 }).catch(() => {}), card.locator('a.knopf').click()]);
          expect(new URL(page.url()).port === String(port), `"Öffnen" von ${name} führt nach ${page.url()}, erwartet Port ${port}`);
          const cfg = await page.evaluate(async () => (await fetch('/api/public-config')).json());
          expect(cfg.productName === name, `Ziel zeigt productName "${cfg.productName}", erwartet "${name}"`);
          await page.goto(`http://127.0.0.1:${port}/login`, { waitUntil: 'domcontentloaded' });
          await page.waitForFunction((t) => document.body.innerText.includes(t), name, { timeout: 20_000 }).catch(() => {});
          const text = await page.evaluate(() => document.body.innerText);
          expect(text.includes(name), `Anmeldeseite von ${name} zeigt den Namen nicht`);
        }
      });
    });
    await s.step('5f Härtung: Portal sendet CSP und weitere Sicherheits-Kopfzeilen', async () => {
      for (const path of ['/', '/index.html', '/registry.json']) {
        const r = await get(`http://127.0.0.1:${needed(pp, 'Portal-Port')}${path}`);
        expect(path === '/' || r.status === 200, `${path}: HTTP ${r.status}`);
        expect(/default-src 'none'/.test(r.headers['content-security-policy'] ?? ''), `${path}: Content-Security-Policy fehlt oder zu weich`);
        expect(String(r.headers['x-content-type-options']).toLowerCase() === 'nosniff', `${path}: X-Content-Type-Options fehlt`);
        expect(String(r.headers['x-frame-options']).toUpperCase() === 'DENY', `${path}: X-Frame-Options fehlt`);
      }
      const post = await httpCall('POST', `http://127.0.0.1:${pp}/`, { body: 'x=1', headers: { 'content-type': 'text/plain' } });
      expect(post.status === 403 || post.status === 405, `POST auf das Portal: HTTP ${post.status}`);
    });
    await s.step('5g Härtung: Portal-Port nur an 127.0.0.1 gebunden', async () => {
      const bad = await checkPortsLoopback([portalProject, projectOf(alpha), projectOf(beta)]);
      expect(bad.length === 0, `nicht an Loopback gebunden: ${bad.join('; ')}`);
    });
    await s.step('5h Härtung: keine Geheimnisse in docker inspect des Portal-Containers; portal.env Rechte 600', async () => {
      const st = await stateOf(portalProject, 'portal');
      expect(st, 'Portal-Container fehlt');
      for (const slug of [alpha, beta]) {
        const leaks = secretsIn(st.info, parseEnv(envFile(ctx, slug)));
        expect(leaks.length === 0, `Portal enthält Geheimnisse von ${slug}: ${leaks.join(', ')}`);
        const web = await stateOf(projectOf(slug), 'control-web');
        expect(secretsIn(web.info, parseEnv(envFile(ctx, slug))).length === 0, `control-web von ${slug} enthält Geheimnisse`);
        expect(modeOf(envFile(ctx, slug)) === '600', `.env von ${slug}: Rechte ${modeOf(envFile(ctx, slug))}`);
      }
      const m = modeOf(join(ctx.dir, 'portal', 'portal.env'));
      expect(m === '600', `portal.env Rechte ${m}`);
      expect(st.info.HostConfig.ReadonlyRootfs === true, 'Portal: Root-Dateisystem nicht schreibgeschützt');
    });
  } finally {
    await teardown(ctx);
  }
}

// ===========================================================================
// Szenario D: TLS (Caddy tls internal -> control-web -> control-api)
// ===========================================================================
async function scenarioTls() {
  const TLS_PORT = 18443;
  const ctx = makeCtx('tls', { caddy: { port: TLS_PORT } });
  const slug = 'e2e-tls';
  const project = projectOf(slug);
  const base = `https://localhost:${TLS_PORT}`;
  ctx.slugs.push(slug);
  let port;
  let email = 'tls-konto@e2e.test';
  const password = `Pw-${randomBytes(12).toString('hex')}`;
  const jar = new Map();
  const absorb = (r) => {
    for (const line of r.setCookie) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  };
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const post = async (path, body, extra = {}) => {
    const csrf = jar.get('csrf') ?? '';
    const r = await httpCall('POST', `${base}${path}`, { body, headers: { cookie: cookieHeader(), 'x-csrf-token': csrf, ...extra } });
    absorb(r);
    return r;
  };
  try {
    await s.step('6a tls: Installation mit COOKIE_SECURE=1, https-URL und TRUST_PROXY=2 startet hinter Caddy', async () => {
      await copyRepo(ctx.dir);
      let r = await install(ctx, ['--mode', 'single', '--software', slug, '--name', 'TLS Verwaltung', '--host', 'localhost', '--non-interactive', '--yes', '--no-start']);
      assert(r.code === 0, `install.sh --no-start Exit ${r.code}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}`);
      const ef = envFile(ctx, slug);
      port = Number(parseEnv(ef).CONTROL_WEB_PORT);
      setEnvLine(ef, 'COOKIE_SECURE', '1');
      setEnvLine(ef, 'CONTROL_RP_ID', 'localhost');
      setEnvLine(ef, 'CONTROL_APP_URL', base);
      setEnvLine(ef, 'CONTROL_TRUST_PROXY', '2');
      r = await cli(ctx, ['up', slug]);
      assert(r.code === 0, `up Exit ${r.code}: ${(r.stderr || r.stdout).trim().split('\n').slice(-4).join(' | ')}`);
      await waitStack(project, port, { timeoutMs: 600_000 });
      await waitFor(async () => (await stateOf(project, 'caddy'))?.status === 'running', { timeoutMs: 60_000, label: 'Caddy läuft' });
    }, STEP_LONG);

    await s.step('6b tls: Anmeldeseite lädt über https (curl -k und Browser)', async () => {
      const c = await run('curl', ['-ksS', '-o', '/dev/null', '-w', '%{http_code} %{scheme}', `${base}/login`], { allowFail: true, timeoutMs: 60_000 });
      expect(c.stdout.trim().startsWith('200 HTTPS'), `curl -k: "${c.stdout.trim()}" ${c.stderr.trim().slice(0, 100)}`);
      const pc = await get(`${base}/api/public-config`);
      expect(pc.json?.productName === 'TLS Verwaltung', `public-config über https: ${pc.text.slice(0, 100)}`);
      await withBrowser(async (page) => {
        const { text, title } = await loginPage(page, base, 'TLS Verwaltung');
        await page.screenshot({ path: join(OUT, 'tls-login.png') });
        expect(page.url().startsWith('https://'), `URL ${page.url()}`);
        expect(text.includes('TLS Verwaltung') || title.includes('TLS Verwaltung'), `Anmeldeseite über https ohne Namen: "${title}"`);
      }, { ignoreHTTPSErrors: true });
    });

    await s.step('6c tls: Login-Antwort setzt Cookies mit Secure + HttpOnly + SameSite', async () => {
      // Erstkonto -> Passwort-Notfalllink -> Passwort setzen -> Anmeldung (Seed ist im Produktions-Container gesperrt).
      let r = await cli(ctx, ['emergency', slug, 'first-account', email, 'TLS', 'Tester']);
      assert(r.code === 0, `first-account Exit ${r.code}: ${(r.stderr || r.stdout).trim().slice(-200)}`);
      const user = /Erstes Konto angelegt: (\S+)/.exec(r.stdout)?.[1];
      assert(user, 'Benutzername nicht in der Ausgabe von first-account');
      r = await cli(ctx, ['emergency', slug, 'password', user]);
      assert(r.code === 0, `emergency password Exit ${r.code}: ${(r.stderr || r.stdout).trim().slice(-200)}`);
      const link = firstUrl(r.stdout);
      const token = /token=([A-Za-z0-9_-]+)/.exec(link ?? '')?.[1];
      expect(token, 'kein Token im Passwort-Link');
      expect(link.startsWith(base), `Passwort-Link beginnt nicht mit ${base}`);
      const csrf = await get(`${base}/api/auth/csrf`, { headers: { cookie: cookieHeader() } });
      absorb(csrf);
      expect(csrf.status === 200 && jar.get('csrf'), `csrf: HTTP ${csrf.status}`);
      const setpw = await post('/api/auth/emergency/password/set', { token, password });
      assert(setpw.status === 200, `Passwort setzen: HTTP ${setpw.status} ${setpw.text.slice(0, 120)}`);
      email = setpw.json?.username ?? user;
      const login = await post('/api/auth/login', { identifier: email, password });
      assert(login.status === 200, `Login: HTTP ${login.status} ${login.text.slice(0, 160)}`);
      const lines = [...csrf.setCookie, ...login.setCookie];
      writeFileSync(join(OUT, 'tls-login-set-cookie.txt'), lines.map((l) => l.replace(/=[^;]+/, '=<wert>')).join('\n') + '\n');
      const named = (n) => login.setCookie.find((l) => l.startsWith(`${n}=`));
      const auth = named('session') ?? named('login');
      expect(auth, `Login setzt weder session- noch login-Cookie (${login.setCookie.map((l) => l.split('=')[0]).join(', ')})`);
      for (const l of login.setCookie.concat(csrf.setCookie)) {
        const n = l.split('=')[0];
        expect(/;\s*Secure/i.test(l), `Cookie ${n} ohne Secure`);
        expect(/;\s*SameSite=(Strict|Lax)/i.test(l), `Cookie ${n} ohne SameSite`);
      }
      expect(/;\s*HttpOnly/i.test(auth), `Cookie ${auth.split('=')[0]} ohne HttpOnly`);
    }, STEP_MID);

    await s.step('6d tls: Rate-Limit zählt die Client-IP; gefälschtes X-Forwarded-For ändert sie nicht', async () => {
      const statuses = [];
      for (let i = 0; i < 12; i++) {
        const r = await post('/api/auth/login', { identifier: 'niemand@e2e.test', password: `falsch-${i}-xxxxxxxxxxxx` }, {
          'x-forwarded-for': `203.0.113.${10 + i}, 198.51.100.${i + 1}`,
          'x-real-ip': `192.0.2.${i + 1}`,
          'x-forwarded-host': `spoof${i}.example`,
        });
        statuses.push(r.status);
        if (r.status === 429) break;
      }
      writeFileSync(join(OUT, 'tls-ratelimit-statuses.txt'), statuses.join(' ') + '\n');
      const first429 = statuses.indexOf(429);
      expect(first429 !== -1, `kein 429 trotz ${statuses.length} Fehlversuchen mit wechselndem X-Forwarded-For: ${statuses.join(' ')}`);
      // Limit 5/min; einen Aufruf hat 6c schon verbraucht: spätestens der 5. Fehlversuch (Index 4) wird gedrosselt.
      expect(first429 <= 5, `Drosselung setzt erst bei Versuch ${first429 + 1} ein: ${statuses.join(' ')}`);
      expect(statuses.slice(0, first429).every((x) => x === 401 || x === 400 || x === 403), `unerwartete Status vor der Drosselung: ${statuses.join(' ')}`);
    });

    await s.step('6e tls: Zugriff direkt auf control-web ist nur über Loopback möglich, TLS-Port ebenfalls', async () => {
      const bad = await checkPortsLoopback([project]);
      expect(bad.length === 0, `nicht an Loopback gebunden: ${bad.join('; ')}`);
      const ca = await stateOf(project, 'caddy');
      expect(ca && Object.keys(ca.info.HostConfig.PortBindings).length === 1, 'Caddy-Portbindung unerwartet');
    });
  } finally {
    await teardown(ctx);
  }
}

// ===========================================================================
const only = (process.env.E2E_INSTALL_ONLY ?? '').split(',').filter(Boolean);
const want = (n) => only.length === 0 || only.includes(n);
try {
  await s.step('0 Voraussetzungen: Docker, rsync, Chromium', async () => {
    await docker(['info'], { timeoutMs: 30_000 });
    await run('rsync', ['--version']);
    const { chromiumPath } = await import('./helpers.mjs');
    assert(existsSync(chromiumPath()), 'Chromium fehlt');
  });
  if (want('single')) await scenarioSingle();
  if (want('plain')) await scenarioPlain();
  if (want('portal')) await scenarioPortal();
  if (want('tls')) await scenarioTls();
} finally {
  // Nur eigene Projekte (saas-instant-e2e-*) anfassen: parallele Suiten bleiben unberührt.
  const mine = async (kind) => {
    const f = kind === 'container' ? ['ps', '-a', '--filter', 'label=e2e=true', '--format', '{{.ID}}|{{.Label "com.docker.compose.project"}}']
      : [kind, 'ls', '--filter', 'label=e2e=true', '--format', kind === 'volume' ? '{{.Name}}|{{.Labels}}' : '{{.ID}}|{{.Labels}}|{{.Name}}'];
    const r = await docker(f, { allowFail: true });
    return r.stdout.split('\n').filter((l) => /saas-instant-e2e-/.test(l));
  };
  const rest = await mine('container');
  if (rest.length) await docker(['rm', '-f', '-v', ...rest.map((l) => l.split('|')[0])], { allowFail: true });
  await s.step('9 Aufräumen: keine eigenen Container/Volumes/Netze (saas-instant-e2e-*) bleiben', async () => {
    expect(rest.length === 0, `${rest.length} Container blieben übrig (entfernt): ${rest.join(', ')}`);
    const v = await mine('volume');
    expect(v.length === 0, `Volumes übrig: ${v.join(', ')}`);
    const n = await mine('network');
    expect(n.length === 0, `Netze übrig: ${n.join(', ')}`);
  });
  void sleep; void productBugs; void cleanup;
  s.finish();
}
