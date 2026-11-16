// Suite sso: Anmeldung über das Portal (OIDC + PKCE) mit echtem Anmeldedienst (portal-auth) und
// echten Verwaltungen (Control-API aus dem Quellcode, Modus portal), im Browser (Playwright).
//
// Aufbau (alles Prozesse auf 127.0.0.1, Hostnamen *.localhost, damit Cookies je Dienst getrennt sind):
//   portal.localhost:13400  Vorderseite (statische Seiten apps/portal + Proxy)  -> portal-auth 13401
//   a.localhost:13410       Verwaltung a (portal)      b.localhost:13411  Verwaltung b (portal)
//   c.localhost:13412       Verwaltung c (portal) gegen einen Attrappen-Aussteller 127.0.0.1:13413
//   127.0.0.1:13414         Verwaltung im Modus single
// Datenbanken e2e_sso_*; keine Docker-Container (nichts zum Etikettieren, nichts bleibt liegen).
import { randomBytes } from 'node:crypto';
import { createSuite, assert } from '../lib/util.mjs';
import { startControl, makeClient, login as localLogin, CONTROL_DIR } from '../lib/control.mjs';
import { run } from '../lib/docker.mjs';
import { FORMS } from '../invoice/fixtures.mjs';
import {
  OUT, expect, sql, startPortalAuth, startPortalFront, createAccount, makePortalClient, startFakeIssuer,
  launchBrowser, ctxApi, errorCode, makeTotp,
} from './helpers.mjs';

const P_FRONT = 13400, P_AUTH = 13401, PA = 13410, PB = 13411, PC = 13412, P_FAKE = 13413, P_SINGLE = 13414;
const PORTAL = `http://portal.localhost:${P_FRONT}`;
const A = `http://a.localhost:${PA}`;
const B = `http://b.localhost:${PB}`;
const C = `http://c.localhost:${PC}`;
const FAKE = `http://127.0.0.1:${P_FAKE}`;
const DB = { a: 'e2e_sso_a', b: 'e2e_sso_b', c: 'e2e_sso_c', single: 'e2e_sso_single' };
const GMBH = FORMS.find((f) => f.key === 'gmbh');

const secret = () => randomBytes(24).toString('base64url');
const SECRET = { a: secret(), b: secret(), c: secret() };
const rand = (p) => `${p}-${randomBytes(9).toString('base64url')}`;

const s = createSuite('sso', { stepTimeoutMs: 240_000 });
const cleanups = [];
const R = {}; // geteilter Zustand der Schritte

async function finishAll() {
  for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* weiter */ } }
}

// ---------------------------------------------------------------------------
// Browser-Hilfen
// ---------------------------------------------------------------------------
/** Beobachtet Navigationen und die SSO-Antworten einer Seite. */
function watch(page) {
  const w = { urls: [], starts: [], callbacks: [] };
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) w.urls.push(f.url()); });
  page.on('response', async (r) => {
    const u = r.url();
    if (u.includes('/api/auth/sso/start')) {
      const raw = (await r.headersArray().catch(() => [])).filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value);
      const flow = raw.map((v) => v.split(';')[0]).find((v) => v.startsWith('sso_flow='));
      w.starts.push({ url: u, status: r.status(), flowCookie: flow });
    }
    if (u.includes('/api/auth/sso/callback')) {
      const text = await r.text().catch(() => '');
      w.callbacks.push({ url: u, status: r.status(), text });
    }
  });
  return w;
}

async function portalLogin(page, who, code) {
  await page.goto(`${PORTAL}/auth/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type=email]').fill(who.email);
  await page.locator('input[type=password]').fill(who.password);
  await page.locator('input[autocomplete=one-time-code]').fill(code);
  await page.locator('form button[type=submit]').click();
}

async function waitCallback(w, before, { timeoutMs = 30_000 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (w.callbacks.length > before) return w.callbacks[before];
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Kein Callback der Verwaltung beobachtet');
}

/** Öffnet die Verwaltung wie der Launcher (SSO-Start) und wartet auf den Callback. */
async function openAdmin(page, w, base) {
  const before = w.callbacks.length;
  await page.goto(`${base}/api/auth/sso/start?return=/&stepup=0`, { waitUntil: 'commit' }).catch(() => {});
  return waitCallback(w, before);
}

/** SSO-Step-up im Browser: frischer Durchlauf mit max_age=0; Faktor wird erneut abgefragt. */
async function stepUp(page, w, base, who, code) {
  const before = w.callbacks.length;
  await page.goto(`${base}/api/auth/sso/start?return=/&stepup=1`, { waitUntil: 'commit' }).catch(() => {});
  await page.waitForURL((u) => u.pathname === '/auth/login' && u.searchParams.get('stepup') === '1', { timeout: 20_000 });
  await page.locator('input[type=password]').fill(who.password);
  await page.locator('input[autocomplete=one-time-code]').fill(code);
  await page.locator('form button[type=submit]').click();
  return waitCallback(w, before);
}

async function waitMe(ctx, base, want, label) {
  const end = Date.now() + 20_000;
  let last;
  while (Date.now() < end) {
    last = await ctxApi(ctx, base, 'GET', '/api/auth/me');
    if (last.status === want) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${label}: /api/auth/me liefert ${last?.status}, erwartet ${want}`);
}

/** Beginnt einen SSO-Durchlauf per HTTP (ohne Browser): liefert Cookie, state, nonce, Adresse. */
async function startFlow(base, { stepup = false } = {}) {
  const r = await fetch(`${base}/api/auth/sso/start?return=/&stepup=${stepup ? 1 : 0}`, { redirect: 'manual' });
  expect(r.status === 302, `sso/start -> ${r.status}, erwartet 302`);
  const loc = new URL(r.headers.get('location'));
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('sso_flow='));
  expect(cookie, 'sso/start setzt kein sso_flow-Cookie');
  return {
    cookie,
    location: loc,
    state: loc.searchParams.get('state'),
    nonce: loc.searchParams.get('nonce'),
    challenge: loc.searchParams.get('code_challenge'),
    redirectUri: loc.searchParams.get('redirect_uri'),
  };
}

/** Ruft den Callback als JSON-Client auf. */
async function callback(base, query, cookie) {
  const qs = new URLSearchParams(query).toString();
  const r = await fetch(`${base}/api/auth/sso/callback?${qs}`, { headers: { accept: 'application/json', ...(cookie ? { cookie } : {}) }, redirect: 'manual' });
  const text = await r.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* HTML */ }
  return { status: r.status, body, text, setCookie: r.headers.getSetCookie() };
}

const sessionCookieSet = (r) => r.setCookie.some((c) => c.startsWith('session=') && !/max-age=0/i.test(c));

// ---------------------------------------------------------------------------
try {
  // ======================================================================= (0) Dienste
  await s.step('(0) Dienste starten: portal-auth, Portal-Vorderseite, Verwaltungen a, b, c und Attrappen-Aussteller', async () => {
    const skipBuild = process.env.E2E_SKIP_BUILD === '1';
    R.portal = await startPortalAuth({ port: P_AUTH, issuer: PORTAL, build: !skipBuild });
    cleanups.push(() => R.portal.dispose());
    R.front = await startPortalFront({
      port: P_FRONT, authPort: P_AUTH,
      registry: {
        title: 'E2E-Portal',
        entries: [
          { slug: 'a', name: 'Verwaltung A', url: `${A}/` },
          { slug: 'b', name: 'Verwaltung B', url: `${B}/` },
        ],
      },
    });
    cleanups.push(() => R.front.stop());

    const portalEnv = (id, app) => ({
      AUTH_MODE: 'portal', PORTAL_ISSUER: PORTAL, PORTAL_INTERNAL_URL: `http://127.0.0.1:${P_AUTH}`,
      PORTAL_CLIENT_ID: id, PORTAL_CLIENT_SECRET: SECRET[id], CONTROL_APP_URL: app,
    });
    // Client-Registrierung per CLI (Geheimnis über stdin).
    for (const [id, base] of [['a', A], ['b', B]]) {
      const r = await R.portal.cli(['client', 'upsert', '--id', id, '--name', `Verwaltung ${id.toUpperCase()}`, '--base-url', base, '--secret-stdin'], { input: `${SECRET[id]}\n` });
      expect(r.code === 0, `client upsert ${id}: ${(r.stderr || r.stdout).trim()}`);
    }
    R.ctlA = await startControl({ port: PA, dbName: DB.a, suite: 'sso', vault: false, env: portalEnv('a', A), build: !skipBuild });
    cleanups.push(() => R.ctlA.stop());
    R.ctlB = await startControl({ port: PB, dbName: DB.b, suite: 'sso', vault: false, env: portalEnv('b', B), build: false });
    cleanups.push(() => R.ctlB.stop());

    // Verwaltung c: Aussteller ist eine Attrappe, die manipulierte Tokens ausliefern kann.
    R.fake = await startFakeIssuer({ port: P_FAKE, issuer: FAKE, clientId: 'c', clientSecret: SECRET.c });
    cleanups.push(() => R.fake.stop());
    R.ctlC = await startControl({
      port: PC, dbName: DB.c, suite: 'sso', vault: false, build: false,
      env: { AUTH_MODE: 'portal', PORTAL_ISSUER: FAKE, PORTAL_INTERNAL_URL: FAKE, PORTAL_CLIENT_ID: 'c', PORTAL_CLIENT_SECRET: SECRET.c, CONTROL_APP_URL: C, PORTAL_JWKS_COOLDOWN_MS: '0' },
    });
    cleanups.push(() => R.ctlC.stop());

    R.browser = await launchBrowser();
    cleanups.push(() => R.browser.close());
  }, { timeoutMs: 900_000 });
  if (!R.browser) throw new Error('Dienste nicht gestartet; Abbruch');

  // ======================================================================= (1) Konten
  await s.step('(1) Erstes Portal-Konto per CLI; Rollen: X admin in a und b, Y nur staff in a', async () => {
    R.X = await createAccount(R.portal, { email: 'x.admin@example.com', name: 'Xaver Admin', password: rand('pw-x'), first: true });
    R.Y = await createAccount(R.portal, { email: 'y.staff@example.com', name: 'Yvonne Staff', password: rand('pw-y') });
    for (const [who, client, role] of [[R.X, 'a', 'admin'], [R.X, 'b', 'admin'], [R.Y, 'a', 'staff']]) {
      const r = await R.portal.cli(['account', 'set-role', '--email', who.email, '--client', client, '--role', role]);
      expect(r.code === 0, `set-role ${who.email} ${client}: ${(r.stderr || r.stdout).trim()}`);
    }
    const list = await R.portal.cli(['client', 'list']);
    assert(/^a\t/m.test(list.stdout) && /^b\t/m.test(list.stdout), `client list: ${list.stdout}`);
    // Ein zweites "create-first" ist abgewiesen.
    const again = await R.portal.cli(['account', 'create-first', '--email', 'z@example.com', '--name', 'Z']);
    expect(again.code !== 0, 'create-first ein zweites Mal wurde nicht abgewiesen');
    assert(R.X.recoveryCodes.length >= 4, `zu wenige Wiederherstellungscodes: ${R.X.recoveryCodes.length}`);
    R.vaultPass = { a: rand('tresor-a'), b: rand('tresor-b') };
  });

  // ======================================================================= (2) X: eine Anmeldung, a und b
  R.ctxX = await R.browser.newContext({ viewport: { width: 1200, height: 800 }, locale: 'de-DE' });
  R.pageX = await R.ctxX.newPage();
  R.wX = watch(R.pageX);
  await s.step('(2) X meldet sich einmal im Portal an (Passwort + TOTP) und öffnet a und b ohne erneute Anmeldung; Tresor einrichten', async () => {
    const { pageX: page, wX: w } = R;
    await portalLogin(page, R.X, await R.X.totp());
    await page.waitForURL((u) => u.origin === PORTAL && u.pathname === '/', { timeout: 20_000 });
    await page.getByText('Verwaltung A').first().waitFor({ timeout: 15_000 });
    const text = await page.evaluate(() => document.body.innerText);
    assert(text.includes('Verwaltung A') && text.includes('Verwaltung B'), `Launcher von X zeigt nicht beide Verwaltungen: ${text.slice(0, 200)}`);
    const loginPagesBefore = w.urls.filter((u) => u.includes('/auth/login')).length;

    for (const [key, base, ctl] of [['a', A, R.ctlA], ['b', B, R.ctlB]]) {
      const cb = await openAdmin(page, w, base);
      expect(cb.status === 200, `Callback ${key}: HTTP ${cb.status}`);
      const start = w.starts.at(-1);
      R[`flow_${key}`] = { cookie: start.flowCookie, callbackUrl: cb.url };
      const me = await waitMe(R.ctxX, base, 200, `Verwaltung ${key}`);
      expect(me.body.accessRole === 'admin', `accessRole in ${key}: ${me.body.accessRole}`);
      expect(me.body.viaPortal === true && me.body.authMode === 'portal', `viaPortal/authMode in ${key}: ${JSON.stringify({ v: me.body.viaPortal, m: me.body.authMode })}`);
      R[`user_${key}`] = me.body.user ?? me.body;
      // Tresor: nach dem Start gesperrt, Einrichtung verlangt einen frischen Nachweis (Step-up).
      const st = await (await fetch(`${base}/api/vault/status`)).json();
      assert(st.state === 'uninitialized', `Tresor in ${key}: ${st.state}`);
      const locked = await ctxApi(R.ctxX, base, 'GET', '/api/companies');
      expect(locked.status === 423, `GET /api/companies vor Tresor-Einrichtung -> ${locked.status}`);
      const noProof = await ctxApi(R.ctxX, base, 'POST', '/api/vault/setup', { passphrase: R.vaultPass[key] });
      expect(noProof.status === 401 && errorCode(noProof) === 'step_up_required', `vault/setup ohne Step-up -> ${noProof.status} ${JSON.stringify(noProof.body).slice(0, 160)}`);
      const su = await stepUp(page, w, base, R.X, R.X.recoveryCodes.shift());
      expect(su.status === 200, `Step-up in ${key}: HTTP ${su.status}`);
      const setup = await ctxApi(R.ctxX, base, 'POST', '/api/vault/setup', { passphrase: R.vaultPass[key] });
      expect(setup.ok && setup.body.recoveryKey, `vault/setup in ${key} -> ${setup.status} ${JSON.stringify(setup.body).slice(0, 160)}`);
      R[`vaultKey_${key}`] = setup.body.recoveryKey;
      const ok = await ctxApi(R.ctxX, base, 'GET', '/api/companies');
      assert(ok.status === 200, `GET /api/companies nach Einrichtung -> ${ok.status}`);
    }
    // Die Anmeldeseite des Portals kam im ganzen Ablauf kein zweites Mal vor außer beim Step-up (stepup=1).
    const extraLogin = w.urls.slice(loginPagesBefore).filter((u) => u.includes('/auth/login') && !u.includes('stepup=1'));
    expect(extraLogin.length === 0, `Portal fragte beim Öffnen von a/b erneut nach der Anmeldung: ${extraLogin.join(' ')}`);
    const login0 = w.urls.filter((u) => u.includes('/auth/login') && !u.includes('stepup=1')).length;
    assert(login0 === 1, `Anmeldeseite ${login0}x aufgerufen (erwartet 1)`);
  });

  // ======================================================================= (3) Y: Rollen
  R.ctxY = await R.browser.newContext({ viewport: { width: 1200, height: 800 }, locale: 'de-DE' });
  R.pageY = await R.ctxY.newPage();
  R.wY = watch(R.pageY);
  await s.step('(3) Y (staff nur in a): b -> 403-Seite; in a Tagesgeschäft ja, Einstellungen/Tresor 403, Entsperren nur admin', async () => {
    const { pageY: page, wY: w } = R;
    await portalLogin(page, R.Y, await R.Y.totp());
    await page.waitForURL((u) => u.origin === PORTAL && u.pathname === '/', { timeout: 20_000 });
    await page.getByText('Verwaltung A').first().waitFor({ timeout: 15_000 });
    const launcher = await page.evaluate(() => document.body.innerText);
    expect(!launcher.includes('Verwaltung B'), 'Launcher von Y zeigt Verwaltung B ohne Rolle');

    // b: keine Rolle -> 403 mit Seite "Kein Zugriff auf diese Verwaltung", kein Konto
    const cbB = await openAdmin(page, w, B);
    expect(cbB.status === 403, `Callback b für Y: HTTP ${cbB.status}`);
    expect(cbB.text.includes('Kein Zugriff auf diese Verwaltung'), `403-Seite ohne den Titel: ${cbB.text.slice(0, 160)}`);
    const meB = await ctxApi(R.ctxY, B, 'GET', '/api/auth/me');
    expect(meB.status === 401, `Y hat in b eine Sitzung: /api/auth/me -> ${meB.status}`);
    const rowsB = await sql(DB.b, `SELECT count(*) FROM "User" WHERE email='${R.Y.email}'`);
    expect(rowsB === '0', `in b wurde ein Konto für Y angelegt (${rowsB})`);

    // a: Neustart -> Tresor gesperrt; Y (staff) darf nicht entsperren, X (admin) schon
    await R.ctlA.restart();
    const cbA = await openAdmin(page, w, A);
    expect(cbA.status === 200, `Callback a für Y: HTTP ${cbA.status}`);
    const meA = await waitMe(R.ctxY, A, 200, 'Y in a');
    expect(meA.body.accessRole === 'staff', `accessRole von Y: ${meA.body.accessRole}`);
    const lockedY = await ctxApi(R.ctxY, A, 'GET', '/api/companies');
    expect(lockedY.status === 423, `nach Neustart GET /api/companies -> ${lockedY.status}`);
    const unlockY = await ctxApi(R.ctxY, A, 'POST', '/api/vault/unlock', { secret: R.vaultPass.a });
    expect(unlockY.status === 403 && errorCode(unlockY) === 'forbidden_role', `Entsperren durch staff -> ${unlockY.status} ${JSON.stringify(unlockY.body).slice(0, 160)}`);
    const stillLocked = await (await fetch(`http://127.0.0.1:${PA}/api/vault/status`)).json();
    expect(stillLocked.state !== 'unlocked', `Tresor nach staff-Entsperren: ${stillLocked.state}`);
    const unlockX = await ctxApi(R.ctxX, A, 'POST', '/api/vault/unlock', { secret: R.vaultPass.a });
    expect(unlockX.ok, `Entsperren durch admin -> ${unlockX.status} ${JSON.stringify(unlockX.body).slice(0, 160)}`);

    // staff: Tagesgeschäft ja
    const created = await ctxApi(R.ctxY, A, 'POST', '/api/companies', { name: 'Staff-Verein e. V.', city: 'Teststadt' });
    expect(created.status === 201, `staff legt Organisation an -> ${created.status} ${JSON.stringify(created.body).slice(0, 160)}`);
    const list = await ctxApi(R.ctxY, A, 'GET', '/api/companies');
    expect(list.status === 200, `staff liest Organisationen -> ${list.status}`);
    // staff: Einstellungen schreiben -> 403 forbidden_role
    const put = await ctxApi(R.ctxY, A, 'PUT', '/api/settings/issuer', { profile: GMBH.profile, accentColor: null });
    expect(put.status === 403 && errorCode(put) === 'forbidden_role', `staff PUT Firmendaten -> ${put.status} ${JSON.stringify(put.body).slice(0, 160)}`);
    const prices = await ctxApi(R.ctxY, A, 'PUT', '/api/settings/prices', {});
    expect(prices.status === 403 && errorCode(prices) === 'forbidden_role', `staff PUT Preise -> ${prices.status}`);
    const setup = await ctxApi(R.ctxY, A, 'POST', '/api/vault/passphrases', { passphrase: rand('x') });
    expect(setup.status === 403 && errorCode(setup) === 'forbidden_role', `staff Tresor-Verwaltung -> ${setup.status}`);
    const issuerGet = await ctxApi(R.ctxY, A, 'GET', '/api/settings/issuer');
    expect(issuerGet.status === 200, `staff liest Firmendaten -> ${issuerGet.status}`);
  });

  // ======================================================================= (4) Step-up
  await s.step('(4) Step-up: X ändert Firmendaten in a -> Portal fragt den Faktor erneut, danach gelingt es; ohne frischen Faktor nicht', async () => {
    const { pageX: page, wX: w } = R;
    // Das Fenster des Step-ups aus der Tresor-Einrichtung (5 Minuten) künstlich altern lassen.
    await sql(DB.a, `UPDATE "SsoSession" SET "stepUpAt" = now() - interval '6 minutes' WHERE "stepUpAt" IS NOT NULL`);
    const body = { profile: GMBH.profile, accentColor: null };
    const stale = await ctxApi(R.ctxX, A, 'PUT', '/api/settings/issuer', body);
    expect(stale.status === 401 && errorCode(stale) === 'step_up_required', `ohne frischen Nachweis -> ${stale.status} ${JSON.stringify(stale.body).slice(0, 160)}`);

    // Step-up gestartet, aber ohne gültigen Faktor abgebrochen: Portal fragt (Anmeldeseite mit stepup=1), falscher Code wird abgewiesen.
    const before = w.callbacks.length;
    await page.goto(`${A}/api/auth/sso/start?return=/&stepup=1`, { waitUntil: 'commit' }).catch(() => {});
    await page.waitForURL((u) => u.pathname === '/auth/login' && u.searchParams.get('stepup') === '1', { timeout: 20_000 });
    await page.locator('input[type=password]').fill(R.X.password);
    await page.locator('input[autocomplete=one-time-code]').fill('000000');
    await page.locator('form button[type=submit]').click();
    await page.locator('[role=alert], .fehler, .meldung').first().waitFor({ timeout: 10_000 }).catch(() => {});
    assert(w.callbacks.length === before, 'Callback trotz falschem Faktor');
    const afterWrong = await ctxApi(R.ctxX, A, 'PUT', '/api/settings/issuer', body);
    expect(afterWrong.status === 401 && errorCode(afterWrong) === 'step_up_required', `nach falschem Faktor -> ${afterWrong.status}`);

    // Nur Passwort/Anmeldung ohne Step-up (frische Sitzung mit stepup=0) ersetzt den Nachweis nicht.
    const plain = await openAdmin(page, w, A);
    expect(plain.status === 200, `normaler SSO-Durchlauf: HTTP ${plain.status}`);
    const stillStale = await ctxApi(R.ctxX, A, 'PUT', '/api/settings/issuer', body);
    expect(stillStale.status === 401, `normaler Durchlauf gilt als Step-up -> ${stillStale.status}`);

    // Mit frischem Faktor gelingt es.
    const su = await stepUp(page, w, A, R.X, R.X.recoveryCodes.shift());
    expect(su.status === 200, `Step-up: HTTP ${su.status}`);
    const put = await ctxApi(R.ctxX, A, 'PUT', '/api/settings/issuer', body);
    expect(put.ok, `PUT Firmendaten nach Step-up -> ${put.status} ${JSON.stringify(put.body).slice(0, 200)}`);
    const back = await ctxApi(R.ctxX, A, 'GET', '/api/settings/issuer');
    expect(back.ok && JSON.stringify(back.body).includes(GMBH.profile.name ?? GMBH.profile.legalName ?? ''), 'Firmendaten nicht gespeichert');
    const fresh = await sql(DB.a, `SELECT count(*) FROM "SsoSession" WHERE "stepUpAt" > now() - interval '1 minute'`);
    assert(Number(fresh) >= 1, 'stepUpAt nicht frisch');
  });

  // ======================================================================= (6) Manipulierte Callbacks
  await s.step('(6a) Manipulierte Callbacks an a: falscher state, fehlendes/verfälschtes Cookie, Wiederholung -> sso_invalid', async () => {
    const reject = (r, what) => expect(r.status === 401 && errorCode(r) === 'sso_invalid', `${what} -> ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    const aLocal = `http://127.0.0.1:${PA}`;
    // falscher state
    const f1 = await startFlow(aLocal);
    reject(await callback(aLocal, { code: 'irgendein-code', state: 'falscher-state' }, f1.cookie), 'falscher state');
    // das Cookie war damit verbraucht? Nein: der Durchlauf bleibt offen, aber der richtige state mit erfundenem Code scheitert am Portal
    reject(await callback(aLocal, { code: 'erfundener-code', state: f1.state }, f1.cookie), 'erfundener Code');
    // der state ist nun verbraucht: derselbe Callback ein zweites Mal
    reject(await callback(aLocal, { code: 'erfundener-code', state: f1.state }, f1.cookie), 'verbrauchter state');
    // ohne Cookie
    const f2 = await startFlow(aLocal);
    reject(await callback(aLocal, { code: 'x', state: f2.state }, undefined), 'Callback ohne Cookie');
    // verfälschtes Cookie (Signatur)
    const tampered = f2.cookie.slice(0, -3) + (f2.cookie.endsWith('AAA') ? 'BBB' : 'AAA');
    reject(await callback(aLocal, { code: 'x', state: f2.state }, tampered), 'verfälschtes Cookie');
    // Cookie eines anderen Durchlaufs mit state eines dritten
    const f3 = await startFlow(aLocal);
    reject(await callback(aLocal, { code: 'x', state: f3.state }, f2.cookie), 'state eines anderen Durchlaufs');
    // Fehlermeldung des Portals im Callback
    const f4 = await startFlow(aLocal);
    reject(await callback(aLocal, { error: 'access_denied', state: f4.state }, f4.cookie), 'error-Parameter');
    // Wiederholung des echten Callbacks aus Schritt 2 (Code und state schon verbraucht, Cookie noch gültig)
    const replayUrl = new URL(R.flow_a.callbackUrl);
    const replay = await callback(aLocal, Object.fromEntries(replayUrl.searchParams), R.flow_a.cookie);
    reject(replay, 'Wiederholung des echten Callbacks');
    assert(!sessionCookieSet(replay), 'Wiederholung setzt ein Sitzungs-Cookie');
    // Fehlertext ohne Einzelheiten nach außen
    const txt = JSON.stringify(replay.body).toLowerCase();
    assert(!/state|nonce|signatur|jwks|cookie/.test(txt), `Antwort verrät Einzelheiten: ${txt.slice(0, 200)}`);
    // Grund steht im Audit-Log (Aktion enthält sso)
    const audits = await sql(DB.a, `SELECT count(*) FROM "AuditLog" WHERE action ILIKE '%sso%'`);
    assert(Number(audits) >= 5, `zu wenige SSO-Audit-Einträge: ${audits}`);
  });

  await s.step('(6b) Code-Wiederholung am Portal: zweite Einlösung -> invalid_grant; Code für falschen Client / falsche redirect_uri', async () => {
    const pc = makePortalClient(R.portal.url, new URL(PORTAL).origin);
    const lg = await pc.call('POST', '/api/auth/login', { email: R.X.email, password: R.X.password, code: R.X.recoveryCodes.shift() });
    expect(lg.ok, `Portal-Anmeldung ohne Browser -> ${lg.status} ${JSON.stringify(lg.body).slice(0, 160)}`);
    const { createHash } = await import('node:crypto');
    const authz = async (redirect) => {
      const verifier = randomBytes(40).toString('base64url');
      const q = new URLSearchParams({
        response_type: 'code', client_id: 'a', redirect_uri: redirect, scope: 'openid', state: 's1', nonce: 'n1',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      });
      const r = await pc.call('GET', `/oauth/authorize?${q}`);
      return { verifier, r, loc: r.headers.get('location') };
    };
    const exchange = (code, verifier, redirect, client = 'a', clientSecret = SECRET.a) => pc.call('POST', '/oauth/token', {
      grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, client_id: client, client_secret: clientSecret,
    }, { form: true });
    const redirect = `${A}/api/auth/sso/callback`;

    const one = await authz(redirect);
    expect(one.r.status === 302 && one.loc, `authorize -> ${one.r.status}`);
    const code = new URL(one.loc).searchParams.get('code');
    expect(code, `kein Code in ${one.loc}`);
    const first = await exchange(code, one.verifier, redirect);
    expect(first.ok && first.body.id_token, `erste Einlösung -> ${first.status} ${JSON.stringify(first.body).slice(0, 160)}`);
    const second = await exchange(code, one.verifier, redirect);
    expect(second.status === 400 && second.body?.error === 'invalid_grant', `zweite Einlösung -> ${second.status} ${JSON.stringify(second.body).slice(0, 160)}`);

    // falscher Verifier verbrennt den Code
    const two = await authz(redirect);
    const code2 = new URL(two.loc).searchParams.get('code');
    const bad = await exchange(code2, randomBytes(40).toString('base64url'), redirect);
    expect(bad.status === 400, `falscher Verifier -> ${bad.status}`);
    const after = await exchange(code2, two.verifier, redirect);
    expect(after.status === 400, `Code nach falschem Verifier noch einlösbar -> ${after.status}`);

    // Code von a mit Client b einlösen: abgewiesen
    const three = await authz(redirect);
    const code3 = new URL(three.loc).searchParams.get('code');
    const wrongClient = await exchange(code3, three.verifier, `${B}/api/auth/sso/callback`, 'b', SECRET.b);
    expect(wrongClient.status === 400, `Code von a bei Client b -> ${wrongClient.status}`);
    // nicht registrierte redirect_uri beim Anfordern
    const evil = await authz('https://evil.example/cb');
    expect(!(evil.loc ?? '').includes('code='), `Code an nicht registrierte redirect_uri: ${evil.loc}`);
  });

  await s.step('(6c) ID-Token manipuliert (Attrappen-Aussteller): aud, iss, abgelaufen, Signatur, nonce, amr, alg=none, iat -> abgelehnt; gültiges Token angenommen', async () => {
    const cLocal = `http://127.0.0.1:${PC}`;
    const now = () => Math.floor(Date.now() / 1000);
    const cases = [
      ['falsches aud', { aud: 'anderer-client' }],
      ['falscher iss', { iss: 'https://evil.example' }],
      ['abgelaufen (exp)', { iat: now() - 700, exp: now() - 400 }],
      ['falsche Signatur (fremder Schlüssel, gleiche kid)', { foreignKey: true }],
      ['falsche nonce', { claims: { nonce: 'nicht-die-richtige' } }],
      ['amr fehlt', { omit: ['amr'] }],
      ['amr leer', { claims: { amr: [] } }],
      ['alg=none ohne Signatur', { alg: 'none' }],
      ['iat in der Zukunft', { iat: now() + 3600, exp: now() + 7200 }],
      ['sub fehlt', { omit: ['sub'] }],
    ];
    for (const [name, next] of cases) {
      const f = await startFlow(cLocal);
      Object.assign(R.fake.state, { next, challenge: f.challenge, nonce: f.nonce, redirectUri: f.redirectUri });
      const r = await callback(cLocal, { code: 'code-1', state: f.state }, f.cookie);
      expect(r.status === 401 && errorCode(r) === 'sso_invalid', `${name} -> ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
      assert(!sessionCookieSet(r), `${name}: Sitzungs-Cookie gesetzt`);
    }
    // Der Token-Aufruf der Verwaltung war korrekt (PKCE, Client-Geheimnis): kein Fehlalarm der Attrappe
    assert(R.fake.state.requests.length === cases.length, `Token-Aufrufe: ${R.fake.state.requests.length}`);
    // Kein Konto ist durch die abgewiesenen Tokens entstanden
    const users = await sql(DB.c, `SELECT count(*) FROM "User" WHERE email='fake@example.com'`);
    expect(users === '0', `abgewiesene Tokens haben ein Konto angelegt (${users})`);

    // Token ohne Rolle für diese Verwaltung: 403, kein Konto
    {
      const f = await startFlow(cLocal);
      Object.assign(R.fake.state, { next: { claims: { roles: { andere: 'admin' }, email: 'ohne-rolle@example.com' } }, challenge: f.challenge, nonce: f.nonce, redirectUri: f.redirectUri });
      const r = await callback(cLocal, { code: 'code-1', state: f.state }, f.cookie);
      expect(r.status === 403 && errorCode(r) === 'no_access', `ohne Rolle -> ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
      const n = await sql(DB.c, `SELECT count(*) FROM "User" WHERE email='ohne-rolle@example.com'`);
      expect(n === '0', `Konto ohne Rolle angelegt (${n})`);
    }
    // Positivprobe: das gleiche Verfahren mit gültigem Token führt zur Anmeldung (Attrappe und Prüfpfad stimmen)
    {
      const f = await startFlow(cLocal);
      Object.assign(R.fake.state, { next: {}, challenge: f.challenge, nonce: f.nonce, redirectUri: f.redirectUri });
      const r = await callback(cLocal, { code: 'code-1', state: f.state }, f.cookie);
      expect(r.status === 200 && sessionCookieSet(r), `gültiges Token -> ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
      const n = await sql(DB.c, `SELECT "accessRole" FROM "User" WHERE email='fake@example.com'`);
      expect(n === 'admin', `Rolle aus dem Token nicht übernommen (${n})`);
    }
  });

  // ======================================================================= (5) Logout
  await s.step('(5) Logout im Portal -> a und b ohne Sitzung (Front-Channel); Y bleibt angemeldet', async () => {
    const { pageX: page, wX: w } = R;
    // Front-Channel mit falschem Aussteller beendet nichts.
    const sid = await sql(DB.a, `SELECT "ssoSid" FROM "SsoSession" s JOIN "User" u ON u.id = s."userId" WHERE u.email='${R.X.email}' AND s."endedAt" IS NULL ORDER BY s."createdAt" DESC LIMIT 1`);
    assert(sid, 'keine laufende SSO-Sitzung von X in a');
    const evil = await fetch(`http://127.0.0.1:${PA}/api/auth/sso/frontchannel-logout?iss=${encodeURIComponent('https://evil.example')}&sid=${encodeURIComponent(sid)}`);
    expect(evil.status === 200, `frontchannel-logout (fremder iss) -> ${evil.status}`);
    await waitMe(R.ctxX, A, 200, 'X in a nach fremdem Front-Channel-Aufruf');

    await waitMe(R.ctxX, B, 200, 'X in b vor dem Logout');
    await page.goto(`${PORTAL}/`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: 'Abmelden' }).click();
    await page.waitForURL((u) => u.origin === PORTAL && u.pathname === '/auth/login', { timeout: 30_000 });
    await waitMe(R.ctxX, A, 401, 'X in a nach Portal-Logout');
    await waitMe(R.ctxX, B, 401, 'X in b nach Portal-Logout');
    const open = await sql(DB.a, `SELECT count(*) FROM "SsoSession" s JOIN "User" u ON u.id = s."userId" WHERE u.email='${R.X.email}' AND s."endedAt" IS NULL`);
    expect(open === '0', `SSO-Sitzungen von X in a nicht beendet (${open})`);
    const portalMe = await page.evaluate(() => fetch('/api/me').then((r) => r.status));
    expect(portalMe === 401, `Portal-Sitzung nach Logout: /api/me -> ${portalMe}`);
    // Neuer Start der Verwaltung führt wieder zur Portal-Anmeldung (kein Code ohne Sitzung).
    await page.goto(`${A}/api/auth/sso/start?return=/&stepup=0`, { waitUntil: 'commit' }).catch(() => {});
    await page.waitForURL((u) => u.origin === PORTAL && u.pathname === '/auth/login', { timeout: 20_000 });
    // Y (eigene Portal-Sitzung) bleibt angemeldet.
    await waitMe(R.ctxY, A, 200, 'Y in a nach Logout von X');
  });

  // ======================================================================= (7) Notzugang bei gestopptem Portal
  await s.step('(7) Portal gestoppt: Notzugang in a mit emergency-Konto funktioniert, normales lokales Konto wird abgelehnt', async () => {
    // Ein zweites lokales Konto aus dem Seed-Konto ableiten (gleiche Faktoren); "notfall" wird per Notfallkommando zum Notzugang.
    await sql(DB.a, `INSERT INTO "User"(id,name,username,email,role,"passwordHash","totpSecret","accessRole",emergency)
      SELECT gen_random_uuid()::text,'Notzugang','notfall','notfall@example.com',role,"passwordHash","totpSecret",'admin',false FROM "User" WHERE username='test'`);
    const cmd = await run('node', ['dist/cli/emergency.js', 'password', 'notfall'], { cwd: CONTROL_DIR, env: R.ctlA.env, allowFail: true, timeoutMs: 120_000 });
    expect(cmd.code === 0, `emergency password endete mit ${cmd.code}: ${(cmd.stderr || cmd.stdout).trim().slice(-300)}`);
    const flags = await sql(DB.a, `SELECT username || '=' || emergency FROM "User" WHERE username IN ('test','notfall') ORDER BY username`);
    expect(flags.split('\n').join(',') === 'notfall=true,test=false', `emergency-Markierung: ${flags}`);

    await R.front.stop();
    await R.portal.stop();
    const down = await fetch(`${PORTAL}/.well-known/jwks.json`).then((r) => r.status).catch(() => 'nicht erreichbar');
    assert(down === 'nicht erreichbar' || down >= 500, `Portal noch erreichbar: ${down}`);

    const aLocal = `http://127.0.0.1:${PA}`;
    // normales lokales Konto (Seed-Konto "test", Passwort stimmt): abgelehnt
    const { api } = makeClient(aLocal);
    const denied = await api('POST', '/api/auth/login', { identifier: 'test', password: 'entwicklung-passwort' });
    expect(denied.status === 403 && errorCode(denied) === 'local_login_disabled', `normales Konto -> ${denied.status} ${JSON.stringify(denied.body).slice(0, 160)}`);
    // Notzugang: Passwort + TOTP
    const em = await localLogin(aLocal, { username: 'notfall' });
    const me = await em.api('GET', '/api/auth/me');
    expect(me.ok && me.body.authMode === 'portal' && me.body.viaPortal === false, `Notzugang /api/auth/me -> ${me.status} ${JSON.stringify(me.body).slice(0, 160)}`);
    const orgs = await em.api('GET', '/api/companies');
    assert(orgs.ok, `Notzugang liest Organisationen -> ${orgs.status}`);
    // SSO-Start schickt weiter zu einem nicht erreichbaren Portal; die Verwaltung selbst bleibt oben.
    const health = await fetch(`${aLocal}/api/health`);
    assert(health.ok, 'Verwaltung a nicht mehr gesund');
  });

  // ======================================================================= (8) Modus single
  await s.step('(8) Verwaltung im Modus single: lokale Anmeldung wie bisher, keine SSO-Routen, kein Step-up', async () => {
    const ctl = await startControl({ port: P_SINGLE, dbName: DB.single, suite: 'sso', build: false });
    cleanups.push(() => ctl.stop());
    const c = await ctl.login();
    const me = await c.api('GET', '/api/auth/me');
    expect(me.ok && me.body.authMode === 'single' && me.body.accessRole === 'admin' && me.body.viaPortal === false, `/api/auth/me -> ${JSON.stringify(me.body).slice(0, 200)}`);
    const pub = await (await fetch(`${ctl.url}/api/public-config`)).json();
    assert(pub.authMode === 'single', `public-config.authMode: ${pub.authMode}`);
    for (const p of ['/api/auth/sso/start', '/api/auth/sso/callback', '/api/auth/sso/frontchannel-logout']) {
      const r = await fetch(`${ctl.url}${p}`, { redirect: 'manual' });
      expect(r.status === 404, `${p} im Modus single -> ${r.status}`);
    }
    // Schreiben in den Einstellungen gelingt mit dem bisherigen Nachweis der frischen Anmeldung (Passwort + TOTP), ohne Step-up.
    const ok = await c.api('PUT', '/api/settings/issuer', { profile: GMBH.profile, accentColor: null });
    expect(ok.ok, `PUT mit frischer lokaler Anmeldung (Nachweis aus Passwort + TOTP) -> ${ok.status} ${JSON.stringify(ok.body).slice(0, 160)}`);
    const bad = await makeClient(ctl.url).api('POST', '/api/auth/login', { identifier: 'test', password: 'falsches-passwort' });
    expect(bad.status === 401, `falsches Passwort -> ${bad.status}`);
  });
} finally {
  await finishAll();
  s.finish();
}
