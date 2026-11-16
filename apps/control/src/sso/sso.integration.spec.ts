import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import * as cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { ControlCharsPipe } from '../common/pipes/control-chars.pipe';
import { NullAsJsonInterceptor } from '../common/interceptors/null-as-json.interceptor';
import { SessionService } from '../auth/session.service';
import { VaultService } from '../vault/vault.service';
import { prisma } from '../test-support/company-provisioning';
import { FakeOidcProvider } from '../test-support/fake-oidc';
import type { FakeAccount } from '../test-support/fake-oidc';
import { TEST_VAULT_PASSPHRASE } from '../test-support/vault';

/**
 * ANMELDUNG ÜBER DAS PORTAL — Ende zu Ende gegen eine echte Datenbank.
 *
 * Gebaut wird die VOLLE Anwendung (`AppModule`) mit echtem HTTP, den echten
 * Guards und dem echten Fehlerfilter. Das Portal ist der kleine OIDC-Anbieter
 * aus `test-support/fake-oidc.ts`: er erzeugt echte Ed25519-signierte ID-Tokens
 * und prüft PKCE, Client-Geheimnis und die Einmaligkeit des Codes selbst.
 */

jest.setTimeout(120_000);

const SLUG = 'sso-test-verwaltung';
const SECRET = 'ein-langes-test-client-geheimnis';
const APP_URL = 'http://localhost:5174';
const TEST_ENV: Record<string, string> = {
  JWT_SECRET: 'sso-integrationstest-jwt-geheimnis-mindestens-32-zeichen',
  CONTROL_CONFIG_KEY: 'sso-test-schluessel-mindestens-32-zeichen-lang',
  CONTROL_APP_URL: APP_URL,
  CONTROL_RP_ID: 'localhost',
  COOKIE_SECURE: '0',
  NODE_ENV: 'test',
};

const run = randomUUID().slice(0, 8);
const emailOf = (label: string) => `${label}-${run}@sso.example.test`;

/** Ein winziger Cookie-Speicher für `fetch`. */
class Jar {
  private readonly values = new Map<string, string>();
  header(): string {
    return [...this.values].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  take(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair = ''] = line.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (/;\s*expires=thu, 01 jan 1970/i.test(line) || value === '') {
        this.values.delete(name);
      } else {
        this.values.set(name, value);
      }
    }
  }
  get(name: string): string | undefined {
    return this.values.get(name);
  }
  set(name: string, value: string): void {
    this.values.set(name, value);
  }
}

interface Reply {
  status: number;
  headers: Headers;
  body: any;
  text: string;
}

async function startApp(env: Record<string, string | undefined>): Promise<{
  app: INestApplication;
  base: string;
}> {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // `AppModule` liest beim Laden `process.env` (Rate-Limit); deshalb erst jetzt.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { AppModule } = require('../app.module') as { AppModule: never };
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = module.createNestApplication();
  app.setGlobalPrefix('api');
  app.use(helmet());
  app.use(cookieParser());
  app.useGlobalPipes(
    new ControlCharsPipe(),
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new NullAsJsonInterceptor());
  await app.init();
  // Der Tresor dieser Anwendung ist nach dem Start gesperrt (wie im Betrieb).
  const vault = app.get(VaultService);
  vault.useKdfParamsForTests({ memoryKib: 8 * 1024, timeCost: 1, parallelism: 1 });
  await vault.unlock(TEST_VAULT_PASSPHRASE, { userId: null, actor: 'test' }, 'test');
  await app.listen(0, '127.0.0.1');
  return {
    app,
    base: `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`,
  };
}

describe('Anmeldung über das Portal (Modus portal)', () => {
  let app: INestApplication;
  let base: string;
  let portal: FakeOidcProvider;
  let account: FakeAccount;
  const userIds: string[] = [];

  async function call(
    method: string,
    path: string,
    jar: Jar,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply> {
    const init: RequestInit = {
      method,
      redirect: 'manual',
      headers: {
        cookie: jar.header(),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(method !== 'GET' && jar.get('csrf') ? { 'x-csrf-token': jar.get('csrf')! } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    const response = await fetch(`${base}${path}`, init);
    jar.take(response);
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: response.status, headers: response.headers, body: parsed, text };
  }

  /** Holt das CSRF-Cookie, wie es die Oberfläche beim Start tut. */
  async function withCsrf(jar: Jar): Promise<Jar> {
    const reply = await call('GET', '/api/auth/csrf', jar);
    jar.set('csrf', (reply.body as { csrfToken: string }).csrfToken);
    return jar;
  }

  /** Läuft bis zur Callback-Adresse und gibt sie samt Cookie-Speicher zurück. */
  async function walkToCallback(
    jar: Jar,
    query = '',
  ): Promise<{ callbackPath: string }> {
    const start = await call('GET', `/api/auth/sso/start${query}`, jar);
    expect(start.status).toBe(302);
    const authorize = start.headers.get('location') as string;
    expect(authorize.startsWith(`${portal.issuer}/oauth/authorize?`)).toBe(true);
    const approved = await fetch(authorize, { redirect: 'manual' });
    expect(approved.status).toBe(302);
    const callback = new URL(approved.headers.get('location') as string);
    return { callbackPath: `${callback.pathname}${callback.search}` };
  }

  /** Ganze Anmeldung: start → Portal → callback. */
  async function login(
    jar: Jar,
    accept = 'application/json',
  ): Promise<Reply> {
    const { callbackPath } = await walkToCallback(jar, '?return=/invoices');
    return call('GET', callbackPath, jar, undefined, { accept });
  }

  /** Eine neue, über das Portal angemeldete Sitzung. */
  async function signedIn(): Promise<Jar> {
    const jar = await withCsrf(new Jar());
    const reply = await login(jar);
    expect(reply.status).toBe(200);
    expect(jar.get('session')).toBeDefined();
    return jar;
  }

  async function userRow() {
    return prisma.user.findUnique({ where: { ssoSubject: account.sub } });
  }

  async function auditReasons(action: string): Promise<string[]> {
    const rows = await prisma.auditLog.findMany({
      where: { action },
      orderBy: { timestamp: 'asc' },
    });
    return rows.map(
      (row) => (row.afterValue as { reason?: string } | null)?.reason ?? '',
    );
  }

  beforeAll(async () => {
    jest.spyOn(ThrottlerGuard.prototype, 'canActivate').mockResolvedValue(true);
    account = {
      sub: `konto-${run}`,
      email: emailOf('erika'),
      name: 'Erika Portal',
      roles: { [SLUG]: 'admin' },
      sid: `sid-${run}`,
    };
    portal = await FakeOidcProvider.start({
      clientId: SLUG,
      clientSecret: SECRET,
      redirectUri: `${APP_URL}/api/auth/sso/callback`,
      account,
    });
    ({ app, base } = await startApp({
      ...TEST_ENV,
      AUTH_MODE: 'portal',
      PORTAL_ISSUER: portal.issuer,
      PORTAL_INTERNAL_URL: portal.issuer,
      PORTAL_CLIENT_ID: SLUG,
      PORTAL_CLIENT_SECRET: SECRET,
      PORTAL_JWKS_COOLDOWN_MS: '0',
    }));
  });

  afterAll(async () => {
    await app.close();
    await portal.stop();
    const users = await prisma.user.findMany({
      where: { email: { endsWith: `-${run}@sso.example.test` } },
      select: { id: true },
    });
    const ids = [...users.map((u) => u.id), ...userIds];
    await prisma.ssoSession.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    portal.resetBehavior();
    account.roles = { [SLUG]: 'admin' };
    account.sid = `sid-${run}`;
    account.sub = `konto-${run}`;
  });

  // -------------------------------------------------------------------------
  // Konfiguration
  // -------------------------------------------------------------------------

  it('meldet authMode=portal in der öffentlichen Konfiguration', async () => {
    const reply = await call('GET', '/api/public-config', new Jar());
    expect(reply.status).toBe(200);
    expect(reply.body.authMode).toBe('portal');
  });

  it('erreicht die SSO-Wege auch bei gesperrtem Tresor (nur auth/**)', async () => {
    const vault = app.get(VaultService);
    await vault.lock({ userId: null, actor: 'test' });
    try {
      const jar = new Jar();
      const start = await call('GET', '/api/auth/sso/start', jar);
      expect(start.status).toBe(302);
      const closed = await call('GET', '/api/companies', jar);
      expect(closed.status).toBe(423);
    } finally {
      await vault.unlock(TEST_VAULT_PASSPHRASE, { userId: null, actor: 'test' }, 'test');
    }
  });

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  it('start: leitet mit state, nonce und PKCE S256 zum Portal und setzt ein Lax-Cookie', async () => {
    const jar = new Jar();
    const reply = await call('GET', '/api/auth/sso/start?return=/invoices', jar);
    expect(reply.status).toBe(302);
    const url = new URL(reply.headers.get('location') as string);
    expect(url.origin + url.pathname).toBe(`${portal.issuer}/oauth/authorize`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(SLUG);
    expect(url.searchParams.get('redirect_uri')).toBe(`${APP_URL}/api/auth/sso/callback`);
    expect(url.searchParams.get('scope')).toBe('openid');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get('state')?.length).toBeGreaterThanOrEqual(32);
    expect(url.searchParams.get('nonce')?.length).toBeGreaterThanOrEqual(32);
    expect(url.searchParams.has('max_age')).toBe(false);
    const cookie = reply.headers.getSetCookie().find((c) => c.startsWith('sso_flow='));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/api\/auth\/sso/);
  });

  it('start: nimmt keinen fremden Rücksprungpfad (offene Weiterleitung)', async () => {
    const jar = await withCsrf(new Jar());
    const { callbackPath } = await walkToCallback(jar, '?return=//boese.example.test');
    const reply = await call('GET', callbackPath, jar);
    expect(reply.status).toBe(200);
    expect(reply.body.returnPath).toBe('/');
  });

  it('start mit stepup=1 verlangt eine laufende Portal-Sitzung', async () => {
    const reply = await call('GET', '/api/auth/sso/start?stepup=1', new Jar());
    expect(reply.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // callback: Erfolg
  // -------------------------------------------------------------------------

  it('callback legt das Konto an, übernimmt die Rolle und meldet an', async () => {
    account.sub = `konto-neu-${run}`;
    account.email = emailOf('neu');
    expect(await userRow()).toBeNull();
    const jar = await withCsrf(new Jar());
    const reply = await login(jar);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true, returnPath: '/invoices' });
    expect(jar.get('sso_flow')).toBeUndefined();

    const user = await userRow();
    expect(user).toMatchObject({
      email: account.email,
      name: 'Erika Portal',
      ssoIssuer: portal.issuer,
      accessRole: 'admin',
      emergency: false,
    });
    expect(user?.passwordHash).toBeNull();

    const me = await call('GET', '/api/auth/me', jar);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      authMode: 'portal',
      accessRole: 'admin',
      viaPortal: true,
      user: { email: account.email },
    });
    const session = jar.get('session') as string;
    expect(session.length).toBeGreaterThan(20);
    expect(await auditReasons('sso.login.success')).toBeDefined();
  });

  it('callback liefert für den Browser eine Seite mit Weiterleitung statt 302', async () => {
    const jar = await withCsrf(new Jar());
    const reply = await login(jar, 'text/html');
    expect(reply.status).toBe(200);
    expect(reply.headers.get('content-type')).toMatch(/text\/html/);
    expect(reply.text).toContain('http-equiv="refresh"');
    expect(reply.text).toContain('url=/invoices');
    expect(reply.headers.get('cache-control')).toBe('no-store');
    expect(jar.get('session')).toBeDefined();
  });

  it('übernimmt die Rolle bei JEDER Anmeldung neu und legt kein zweites Konto an', async () => {
    account.roles = { [SLUG]: 'staff' };
    const jar = await withCsrf(new Jar());
    expect((await login(jar)).status).toBe(200);
    expect((await userRow())?.accessRole).toBe('staff');
    const me = await call('GET', '/api/auth/me', jar);
    expect(me.body.accessRole).toBe('staff');
    expect(
      await prisma.user.count({ where: { ssoSubject: account.sub } }),
    ).toBe(1);

    account.roles = { [SLUG]: 'admin' };
    const again = await withCsrf(new Jar());
    expect((await login(again)).status).toBe(200);
    expect((await userRow())?.accessRole).toBe('admin');
  });

  it('verknüpft ein bestehendes lokales Konto mit derselben Adresse', async () => {
    const local = await prisma.user.create({
      data: {
        name: 'Lokal Lena',
        email: emailOf('lokal'),
        username: emailOf('lokal'),
        role: 'administrator',
      },
    });
    userIds.push(local.id);
    account.sub = `konto-lokal-${run}`;
    account.email = emailOf('lokal');
    const jar = await withCsrf(new Jar());
    expect((await login(jar)).status).toBe(200);
    const linked = await prisma.user.findUniqueOrThrow({ where: { id: local.id } });
    expect(linked.ssoSubject).toBe(account.sub);
    expect(await prisma.user.count({ where: { email: emailOf('lokal') } })).toBe(1);
  });

  it('übersteht einen Schlüsselwechsel des Portals (neue kid, JWKS wird neu geholt)', async () => {
    await signedIn();
    const before = portal.jwksFetches;
    await portal.rotateKey();
    const jar = await withCsrf(new Jar());
    expect((await login(jar)).status).toBe(200);
    expect(portal.jwksFetches).toBeGreaterThan(before);
  });

  // -------------------------------------------------------------------------
  // callback: Fehler
  // -------------------------------------------------------------------------

  async function expectInvalid(reply: Reply): Promise<void> {
    expect(reply.status).toBe(401);
    expect(reply.body).toEqual({
      error: {
        code: 'sso_invalid',
        message: 'Die Anmeldung über das Portal ist fehlgeschlagen.',
      },
    });
  }

  it.each([
    ['falsches aud', { aud: 'eine-andere-verwaltung' }],
    ['falsches iss', { iss: 'https://boese.example.test' }],
    ['abgelaufenes Token', { exp: Math.floor(Date.now() / 1000) - 10, iat: Math.floor(Date.now() / 1000) - 400 }],
    ['iat weit in der Zukunft', { iat: Math.floor(Date.now() / 1000) + 600 }],
    ['falsche nonce', { nonce: 'nicht-die-gesendete' }],
  ])('callback: %s -> 401 sso_invalid, kein Konto, keine Sitzung', async (_label, overrides) => {
    portal.overrides = overrides;
    account.sub = `konto-fehler-${randomUUID().slice(0, 6)}`;
    account.email = emailOf(`fehler-${randomUUID().slice(0, 6)}`);
    const jar = await withCsrf(new Jar());
    const reply = await login(jar);
    await expectInvalid(reply);
    expect(jar.get('session')).toBeUndefined();
    expect(await prisma.user.count({ where: { email: account.email } })).toBe(0);
  });

  it('callback: Signatur mit fremdem Schlüssel -> 401', async () => {
    portal.signWithForeignKey = true;
    const jar = await withCsrf(new Jar());
    await expectInvalid(await login(jar));
    expect(jar.get('session')).toBeUndefined();
  });

  it('callback: fehlendes amr -> 401; leeres amr -> 401', async () => {
    portal.omit = ['amr'];
    await expectInvalid(await login(await withCsrf(new Jar())));
    portal.omit = [];
    portal.overrides = { amr: [] };
    await expectInvalid(await login(await withCsrf(new Jar())));
  });

  it('callback: fehlende sid oder auth_time -> 401', async () => {
    portal.omit = ['sid'];
    await expectInvalid(await login(await withCsrf(new Jar())));
    portal.omit = ['auth_time'];
    await expectInvalid(await login(await withCsrf(new Jar())));
  });

  it('callback: Detail landet im Audit-Log, nie in der Antwort', async () => {
    portal.overrides = { aud: 'eine-andere-verwaltung' };
    const reply = await login(await withCsrf(new Jar()));
    expect(reply.text).not.toMatch(/aud|ERR_JWT|Claim/i);
    const reasons = await auditReasons('sso.login.failure');
    expect(reasons.some((r) => /aud/.test(r))).toBe(true);
  });

  it('callback: state passt nicht zum Cookie -> 401, ohne das Portal zu fragen', async () => {
    const jar = await withCsrf(new Jar());
    const { callbackPath } = await walkToCallback(jar);
    const before = portal.tokenRequests.length;
    const forged = callbackPath.replace(/state=[^&]+/, 'state=gefaelscht');
    await expectInvalid(await call('GET', forged, jar));
    expect(portal.tokenRequests.length).toBe(before);
  });

  it('callback: ohne Cookie des Durchlaufs -> 401', async () => {
    const jar = await withCsrf(new Jar());
    const { callbackPath } = await walkToCallback(jar);
    const without = await withCsrf(new Jar());
    await expectInvalid(await call('GET', callbackPath, without));
  });

  it('callback: Replay desselben Durchlaufs (state, nonce) scheitert und fragt das Portal nicht erneut', async () => {
    const jar = await withCsrf(new Jar());
    const { callbackPath } = await walkToCallback(jar);
    const cookie = jar.get('sso_flow') as string;
    const first = await call('GET', callbackPath, jar);
    expect(first.status).toBe(200);
    const requests = portal.tokenRequests.length;

    const replayJar = await withCsrf(new Jar());
    replayJar.set('sso_flow', cookie);
    await expectInvalid(await call('GET', callbackPath, replayJar));
    expect(portal.tokenRequests.length).toBe(requests);
    expect(replayJar.get('session')).toBeUndefined();
  });

  it('callback: ein Cookie aus einem anderen Durchlauf passt nicht zu fremdem state', async () => {
    const a = await withCsrf(new Jar());
    const b = await withCsrf(new Jar());
    const { callbackPath } = await walkToCallback(a);
    await walkToCallback(b);
    await expectInvalid(await call('GET', callbackPath, b));
  });

  it('callback: Fehlerparameter des Portals -> 401', async () => {
    const jar = await withCsrf(new Jar());
    await walkToCallback(jar);
    const state = new URL(
      (await call('GET', '/api/auth/sso/start', jar)).headers.get('location') as string,
    ).searchParams.get('state');
    await expectInvalid(
      await call('GET', `/api/auth/sso/callback?error=access_denied&state=${state}`, jar),
    );
  });

  it('callback: Rücksprung als Browser-Seite zeigt auf /login?sso=failed', async () => {
    portal.signWithForeignKey = true;
    const reply = await login(await withCsrf(new Jar()), 'text/html');
    expect(reply.status).toBe(401);
    expect(reply.text).toContain('url=/login?sso=failed');
  });

  it('ohne roles[slug]: 403 no_access, es entsteht kein Konto und keine Sitzung', async () => {
    account.roles = { andere: 'admin' };
    account.sub = `konto-ohne-${run}`;
    account.email = emailOf('ohne');
    const jar = await withCsrf(new Jar());
    const reply = await login(jar);
    expect(reply.status).toBe(403);
    expect(reply.body.error.code).toBe('no_access');
    expect(jar.get('session')).toBeUndefined();
    expect(await prisma.user.count({ where: { ssoSubject: account.sub } })).toBe(0);

    const page = await login(await withCsrf(new Jar()), 'text/html');
    expect(page.status).toBe(403);
    expect(page.text).toContain('Kein Zugriff auf diese Verwaltung');
    expect(page.text).toContain('url=/no-access');
  });

  it('ein entzogener Zugang kommt über das Portal nicht hinein', async () => {
    account.sub = `konto-entzogen-${run}`;
    account.email = emailOf('entzogen');
    const jar = await withCsrf(new Jar());
    expect((await login(jar)).status).toBe(200);
    await prisma.user.update({
      where: { ssoSubject: account.sub },
      data: { deactivatedAt: new Date() },
    });
    const again = await withCsrf(new Jar());
    const reply = await login(again);
    expect(reply.status).toBe(403);
    expect(again.get('session')).toBeUndefined();
    // Auch die bestehende Sitzung endet sofort.
    expect((await call('GET', '/api/auth/me', jar)).status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Rollen
  // -------------------------------------------------------------------------

  describe('Rolle staff', () => {
    let staff: Jar;

    beforeAll(async () => {
      account.roles = { [SLUG]: 'staff' };
      account.sub = `konto-staff-${run}`;
      account.email = emailOf('staff');
      account.sid = `sid-staff-${run}`;
      staff = await signedIn();
    });

    it.each([
      ['PUT', '/api/settings/prices', { taxRatePercent: 19 }],
      ['PUT', '/api/settings/issuer', {}],
      ['DELETE', '/api/settings/issuer/logo', undefined],
      ['PUT', '/api/settings/backup', {}],
      ['POST', '/api/settings/backup/test', {}],
      ['PUT', '/api/feature-flags/irgendeiner', { enabled: true }],
      ['POST', '/api/users', { name: 'X', email: 'x@example.test' }],
      ['PATCH', '/api/users/6f6a2f9e-4b53-4c35-8d83-0f5c8b6a1e11/access', { active: false }],
      ['POST', '/api/vault/unlock', { secret: 'egal' }],
      ['POST', '/api/vault/setup', { passphrase: 'egal' }],
      ['POST', '/api/instances/x/restores', {}],
      ['POST', '/api/instances/x/restores/y/adopt', {}],
    ])('%s %s -> 403 forbidden_role (vor Validierung und Step-up)', async (method, path, body) => {
      const reply = await call(method, path, staff, body ?? undefined);
      expect(reply.status).toBe(403);
      expect(reply.body.error.code).toBe('forbidden_role');
    });

    it('darf das Tagesgeschäft und Einstellungen lesen', async () => {
      for (const path of ['/api/companies', '/api/invoices', '/api/settings/prices', '/api/settings/issuer', '/api/users', '/api/feature-flags']) {
        const reply = await call('GET', path, staff);
        expect(reply.status).toBe(200);
      }
    });

    it('darf Organisationen anlegen (Tagesgeschäft)', async () => {
      const reply = await call('POST', '/api/companies', staff, {
        name: `Staff Test ${run}`,
      });
      expect([200, 201]).toContain(reply.status);
      if (reply.body?.id) {
        await prisma.company.deleteMany({ where: { id: reply.body.id } });
      }
    });

    it('wird bei Rechnungs-Festschreibung nach dem Step-up gefragt, nicht nach Passwort', async () => {
      const reply = await call('POST', '/api/invoices/nicht-da/finalize', staff, {
        currentPassword: 'egal',
      });
      expect(reply.status).toBe(401);
      expect(reply.body.error.code).toBe('step_up_required');
    });
  });

  describe('Rolle admin', () => {
    it('kommt an den Schreibwegen am RoleGuard vorbei und scheitert erst am Step-up', async () => {
      const jar = await signedIn();
      const reply = await call('PUT', '/api/settings/prices', jar, { taxRatePercent: 19 });
      expect(reply.status).toBe(401);
      expect(reply.body.error.code).toBe('step_up_required');
    });
  });

  // -------------------------------------------------------------------------
  // Step-up
  // -------------------------------------------------------------------------

  describe('Step-up', () => {
    let jar: Jar;

    /** Setzt den kompletten Step-up-Durchlauf an. */
    async function stepUp(): Promise<Reply> {
      const { callbackPath } = await walkToCallback(jar, '?stepup=1&return=/settings');
      return call('GET', callbackPath, jar);
    }

    /** Eine gültige Preisliste im Format des Schreibwegs. */
    async function pricesBody() {
      const current = await call('GET', '/api/settings/prices', jar);
      expect(current.status).toBe(200);
      const { updatedAt: _updatedAt, ...rest } = current.body as Record<string, unknown>;
      const tiers = (rest['tiers'] as unknown[]).length
        ? rest['tiers']
        : [
            {
              key: 'standard',
              label: 'Standard',
              maxPersons: null,
              monthlyCent: 1000,
              halfYearlyCent: 5500,
              yearlyCent: 10000,
              setupCent: 0,
            },
          ];
      return { ...rest, tiers };
    }

    async function sessionRow() {
      const row = await prisma.ssoSession.findFirst({
        where: { user: { ssoSubject: account.sub }, endedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      return row!;
    }

    beforeEach(async () => {
      account.sub = `konto-up-${run}`;
      account.email = emailOf('up');
      account.sid = `sid-up-${randomUUID().slice(0, 6)}`;
      jar = await signedIn();
    });

    it('verlangt ohne Step-up step_up_required statt des Passwort-Dialogs', async () => {
      const reply = await call('PUT', '/api/settings/prices', jar, await pricesBody());
      expect(reply.status).toBe(401);
      expect(reply.body.error.code).toBe('step_up_required');
    });

    it('sendet max_age=0 und schaltet die Aktion nach einem frischen Durchlauf mit zweitem Faktor frei', async () => {
      const start = await call('GET', '/api/auth/sso/start?stepup=1&return=/settings', jar);
      expect(new URL(start.headers.get('location') as string).searchParams.get('max_age')).toBe('0');

      const done = await stepUp();
      expect(done.status).toBe(200);
      expect(done.body.returnPath).toBe('/settings');
      expect((await sessionRow()).stepUpAt).not.toBeNull();

      const body = await pricesBody();
      const saved = await call('PUT', '/api/settings/prices', jar, body);
      expect(saved.status).toBe(200);
    });

    it('akzeptiert auch einen Passkey (hwk) als zweiten Faktor', async () => {
      portal.stepUpAmr = ['hwk'];
      expect((await stepUp()).status).toBe(200);
      expect((await sessionRow()).stepUpAt).not.toBeNull();
    });

    it('lehnt einen Durchlauf OHNE zweiten Faktor ab (amr nur pwd)', async () => {
      portal.stepUpAmr = ['pwd'];
      const reply = await stepUp();
      await expectInvalid(reply);
      expect((await sessionRow()).stepUpAt).toBeNull();
    });

    it('lehnt ein auth_time vor dem Start des Step-ups ab', async () => {
      portal.overrides = { auth_time: Math.floor(Date.now() / 1000) - 3600 };
      await expectInvalid(await stepUp());
      expect((await sessionRow()).stepUpAt).toBeNull();
    });

    it('lehnt einen Step-up mit dem Token eines anderen Kontos ab', async () => {
      portal.overrides = { sub: 'ein-ganz-anderes-konto' };
      await expectInvalid(await stepUp());
      expect((await sessionRow()).stepUpAt).toBeNull();
    });

    it('gilt fünf Minuten, danach wieder step_up_required', async () => {
      expect((await stepUp()).status).toBe(200);
      const row = await sessionRow();
      const body = await pricesBody();
      expect((await call('PUT', '/api/settings/prices', jar, body)).status).toBe(200);

      await prisma.ssoSession.update({
        where: { id: row.id },
        data: { stepUpAt: new Date(Date.now() - 6 * 60_000) },
      });
      const late = await call('PUT', '/api/settings/prices', jar, body);
      expect(late.status).toBe(401);
      expect(late.body.error.code).toBe('step_up_required');
    });

    it('meldet einen gescheiterten Step-up der Seite als Rücksprung mit sso=failed', async () => {
      portal.stepUpAmr = ['pwd'];
      const { callbackPath } = await walkToCallback(jar, '?stepup=1&return=/sso-done');
      const reply = await call('GET', callbackPath, jar, undefined, { accept: 'text/html' });
      expect(reply.status).toBe(401);
      expect(reply.text).toContain('url=/sso-done?sso=failed');
    });

    it('der Step-up der einen Sitzung gilt nicht für eine andere', async () => {
      expect((await stepUp()).status).toBe(200);
      const other = await signedIn();
      const reply = await call('PUT', '/api/settings/prices', other, await pricesBody());
      expect(reply.body.error.code).toBe('step_up_required');
    });
  });

  // -------------------------------------------------------------------------
  // Abmelden
  // -------------------------------------------------------------------------

  describe('Abmelden', () => {
    beforeEach(() => {
      account.sub = `konto-out-${run}`;
      account.email = emailOf('out');
    });

    it('Front-Channel-Logout beendet alle Sitzungen mit dieser sid, nur diese', async () => {
      account.sid = `sid-A-${run}`;
      const a1 = await signedIn();
      const a2 = await signedIn();
      account.sid = `sid-B-${run}`;
      const b = await signedIn();
      for (const jar of [a1, a2, b]) {
        expect((await call('GET', '/api/auth/me', jar)).status).toBe(200);
      }

      const reply = await call(
        'GET',
        `/api/auth/sso/frontchannel-logout?iss=${encodeURIComponent(portal.issuer)}&sid=sid-A-${run}`,
        new Jar(),
      );
      expect(reply.status).toBe(200);
      expect((await call('GET', '/api/auth/me', a1)).status).toBe(401);
      expect((await call('GET', '/api/auth/me', a2)).status).toBe(401);
      expect((await call('GET', '/api/auth/me', b)).status).toBe(200);
      expect(await prisma.ssoSession.count({ where: { ssoSid: `sid-A-${run}`, endedAt: null } })).toBe(0);
    });

    it('Front-Channel-Logout ist einbettbar nur durch das Portal', async () => {
      const reply = await call(
        'GET',
        `/api/auth/sso/frontchannel-logout?iss=${encodeURIComponent(portal.issuer)}&sid=unbekannt`,
        new Jar(),
      );
      expect(reply.status).toBe(200);
      expect(reply.headers.get('x-frame-options')).toBeNull();
      expect(reply.headers.get('content-security-policy')).toBe(
        `default-src 'none'; frame-ancestors ${portal.issuer}`,
      );
    });

    it('Front-Channel-Logout mit fremdem iss beendet nichts', async () => {
      account.sid = `sid-C-${run}`;
      const jar = await signedIn();
      const reply = await call(
        'GET',
        `/api/auth/sso/frontchannel-logout?iss=${encodeURIComponent('https://boese.example.test')}&sid=sid-C-${run}`,
        new Jar(),
      );
      expect(reply.status).toBe(200);
      expect((await call('GET', '/api/auth/me', jar)).status).toBe(200);
      const none = await call('GET', '/api/auth/sso/frontchannel-logout', new Jar());
      expect(none.status).toBe(200);
    });

    it('Abmelden beendet die Sitzung und nennt die Adresse des Portal-Logouts', async () => {
      account.sid = `sid-D-${run}`;
      const jar = await signedIn();
      const reply = await call('POST', '/api/auth/logout', jar, {});
      expect(reply.status).toBe(200);
      const url = new URL(reply.body.portalLogoutUrl);
      expect(url.origin + url.pathname).toBe(`${portal.issuer}/oauth/logout`);
      expect(url.searchParams.get('client_id')).toBe(SLUG);
      expect(url.searchParams.get('post_logout_redirect_uri')).toBe(`${APP_URL}/`);
      // Auch mit dem alten Cookie ist die Sitzung tot.
      const stale = new Jar();
      expect((await call('GET', '/api/auth/me', stale)).status).toBe(401);
      expect(await prisma.ssoSession.count({ where: { ssoSid: `sid-D-${run}`, endedAt: null } })).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Notzugang
  // -------------------------------------------------------------------------

  describe('Notzugang', () => {
    const password = 'ein-hinreichend-langes-notfall-passwort';

    async function localUser(label: string, emergency: boolean) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const argon2 = require('argon2') as typeof import('argon2');
      const user = await prisma.user.create({
        data: {
          name: `Lokal ${label}`,
          email: emailOf(label),
          username: emailOf(label),
          role: 'owner',
          emergency,
          passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
          loginCodeEnabled: true,
        },
      });
      userIds.push(user.id);
      return user;
    }

    it('lokale Anmeldung ohne emergency -> 403 local_login_disabled', async () => {
      await localUser('normal', false);
      const reply = await call('POST', '/api/auth/login', await withCsrf(new Jar()), {
        identifier: emailOf('normal'),
        password,
      });
      expect(reply.status).toBe(403);
      expect(reply.body.error.code).toBe('local_login_disabled');
    });

    it('lokale Anmeldung mit emergency=true wird angenommen (weiter zum zweiten Faktor)', async () => {
      await localUser('notfall', true);
      const reply = await call('POST', '/api/auth/login', await withCsrf(new Jar()), {
        identifier: emailOf('notfall'),
        password,
      });
      expect(reply.status).toBe(200);
      expect(reply.body.secondFactorRequired).toBe(true);
    });

    it('falsches Passwort eines Nicht-Notzugangs verrät nichts: wie bisher login_failed', async () => {
      await localUser('falsch', false);
      const reply = await call('POST', '/api/auth/login', await withCsrf(new Jar()), {
        identifier: emailOf('falsch'),
        password: 'ein-ganz-falsches-passwort',
      });
      expect(reply.status).toBe(401);
      expect(reply.body.error.code).toBe('login_failed');
    });

    it('eine lokale Sitzung gilt nur für Notzugänge', async () => {
      const normal = await localUser('sitzung-normal', false);
      const emergency = await localUser('sitzung-notfall', true);
      const sessions = app.get(SessionService);
      const bad = new Jar();
      bad.set('session', await sessions.createToken(normal.id));
      expect((await call('GET', '/api/auth/me', bad)).status).toBe(401);
      const good = new Jar();
      good.set('session', await sessions.createToken(emergency.id));
      const me = await call('GET', '/api/auth/me', good);
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ viaPortal: false, authMode: 'portal', accessRole: 'admin' });
    });

    it('ein Notzugang braucht für heikle Aktionen weiter Passwort oder TOTP (kein Step-up)', async () => {
      const emergency = await localUser('lokal-heikel', true);
      const jar = await withCsrf(new Jar());
      jar.set('session', await app.get(SessionService).createToken(emergency.id, new Date(0)));
      const reply = await call('PUT', '/api/settings/prices', jar, {
        taxRatePercent: 19,
        paymentTermDays: 14,
        averageDays: 30,
        tiers: [{ key: 'a', label: 'A', monthlyCent: 0 }],
      });
      expect(reply.status).toBe(401);
      expect(reply.body.error.code).toBe('login_failed');
    });
  });
});

describe('Modus single bleibt unverändert', () => {
  let app: INestApplication;
  let base: string;
  const createdUsers: string[] = [];

  async function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
    const response = await fetch(`${base}${path}`, {
      method,
      redirect: 'manual',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed, headers: response.headers };
  }

  beforeAll(async () => {
    jest.spyOn(ThrottlerGuard.prototype, 'canActivate').mockResolvedValue(true);
    ({ app, base } = await startApp({
      ...TEST_ENV,
      AUTH_MODE: undefined,
      PORTAL_ISSUER: undefined,
      PORTAL_INTERNAL_URL: undefined,
      PORTAL_CLIENT_ID: undefined,
      PORTAL_CLIENT_SECRET: undefined,
    }));
  });

  afterAll(async () => {
    await app.close();
    await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
    jest.restoreAllMocks();
  });

  it('public-config meldet authMode=single', async () => {
    expect((await call('GET', '/api/public-config')).body.authMode).toBe('single');
  });

  it('die SSO-Wege gibt es nicht (404)', async () => {
    for (const path of ['/api/auth/sso/start', '/api/auth/sso/callback', '/api/auth/sso/frontchannel-logout']) {
      expect((await call('GET', path)).status).toBe(404);
    }
  });

  it('lokale Anmeldung wie bisher: Passwort, dann zweiter Faktor — auch ohne emergency', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const argon2 = require('argon2') as typeof import('argon2');
    const user = await prisma.user.create({
      data: {
        name: 'Lokal Single',
        email: `single-${run}@sso.example.test`,
        username: `single-${run}@sso.example.test`,
        role: 'owner',
        passwordHash: await argon2.hash('ein-hinreichend-langes-passwort', { type: argon2.argon2id }),
        loginCodeEnabled: true,
        // Rest aus einem früheren Portalbetrieb: gilt im Modus single NICHT.
        accessRole: 'staff',
      },
    });
    createdUsers.push(user.id);
    const csrf = await call('GET', '/api/auth/csrf');
    const token = csrf.body.csrfToken as string;
    const login = await call(
      'POST',
      '/api/auth/login',
      { cookie: `csrf=${token}`, 'x-csrf-token': token },
      { identifier: user.email, password: 'ein-hinreichend-langes-passwort' },
    );
    expect(login.status).toBe(200);
    expect(login.body.secondFactorRequired).toBe(true);
  });

  it('jedes Konto ist admin; Schreibwege fragen wie bisher nach Passwort oder TOTP', async () => {
    const user = await prisma.user.create({
      data: {
        name: 'Single Staff-Rest',
        email: `single-rest-${run}@sso.example.test`,
        username: `single-rest-${run}@sso.example.test`,
        role: 'administrator',
        accessRole: 'staff',
      },
    });
    createdUsers.push(user.id);
    const sessions = app.get(SessionService);
    const session = await sessions.createToken(user.id, new Date(0));
    const csrf = (await call('GET', '/api/auth/csrf')).body.csrfToken as string;
    const headers = { cookie: `session=${session}; csrf=${csrf}`, 'x-csrf-token': csrf };

    const me = await call('GET', '/api/auth/me', headers);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ authMode: 'single', accessRole: 'admin', viaPortal: false });

    // Kein 403 forbidden_role, sondern die bisherige Nachweisabfrage.
    const prices = await call('PUT', '/api/settings/prices', headers, {
      taxRatePercent: 19,
      paymentTermDays: 14,
      averageDays: 30,
      tiers: [{ key: 'a', label: 'A', monthlyCent: 0 }],
    });
    expect(prices.status).toBe(401);
    expect(prices.body.error.code).toBe('login_failed');
  });
});
