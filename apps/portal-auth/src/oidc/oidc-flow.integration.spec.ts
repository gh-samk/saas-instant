import { Browser, Harness, TestAccount, newPkce } from '../test-support/harness';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('OIDC-Code-Flow mit PKCE (echte Datenbank)', () => {
  const h = new Harness();
  let client: Awaited<ReturnType<Harness['client']>>;
  let other: Awaited<ReturnType<Harness['client']>>;
  let anna: TestAccount;

  beforeAll(async () => {
    await h.start();
    client = await h.client(`demo-${h.runId}`);
    other = await h.client(`zweit-${h.runId}`);
    anna = await h.account({ name: 'Anna Test', roles: { [client.id]: 'admin', [other.id]: 'staff' } });
  });
  afterAll(async () => {
    await h.prisma.oidcClient.deleteMany({ where: { id: { in: [client.id, other.id] } } });
    await h.cleanup();
    await h.stop();
  });

  /** Anmeldung über die Anmeldeseite des Portals, danach Rückkehr mit Code. */
  async function viaLogin(b: Browser, acc: TestAccount, c = client, extra: Record<string, string> = {}) {
    const pkce = newPkce();
    const a = h.authorizePath(c, pkce, extra);
    const first = await b.get(a.path);
    expect(first.status).toBe(302);
    const loginUrl = new URL(first.location!);
    const req = loginUrl.searchParams.get('req')!;
    const login = await h.login(b, acc, { req });
    expect(login.status).toBe(200);
    const back = await b.get(login.body.next);
    return { ...h.codeFrom(back.location, c), pkce, a, req };
  }

  async function idTokenOf(b: Browser, c: typeof client, code: string, verifier: string) {
    const res = await h.tokenRequest(b, c, code, verifier);
    expect(res.status).toBe(200);
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.expires_in).toBe(300);
    return h.verifyIdToken(res.body.id_token, c.id);
  }

  it('veröffentlicht Discovery und JWKS (EdDSA, kid, kein privater Anteil)', async () => {
    const b = h.browser();
    const disco = await b.get('/.well-known/openid-configuration');
    expect(disco.body.issuer).toBe(h.issuer);
    expect(disco.body.authorization_endpoint).toBe(`${h.issuer}/oauth/authorize`);
    expect(disco.body.token_endpoint).toBe(`${h.issuer}/oauth/token`);
    expect(disco.body.jwks_uri).toBe(`${h.issuer}/.well-known/jwks.json`);
    expect(disco.body.id_token_signing_alg_values_supported).toEqual(['EdDSA']);
    expect(disco.body.code_challenge_methods_supported).toEqual(['S256']);
    const jwks = await b.get('/.well-known/jwks.json');
    expect(jwks.body.keys.length).toBeGreaterThanOrEqual(1);
    for (const k of jwks.body.keys) {
      expect(k).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig' });
      expect(typeof k.kid).toBe('string');
      expect(k.d).toBeUndefined();
    }
  });

  it('Code-Flow: ohne Sitzung zur Anmeldeseite, danach Code, Token mit allen Claims', async () => {
    const b = h.browser();
    const before = Math.floor(Date.now() / 1000);
    const { code, state, iss, pkce, a } = await viaLogin(b, anna);
    expect(state).toBe(a.state);
    expect(iss).toBe(h.issuer);
    const { payload, kid } = await idTokenOf(b, client, code, pkce.verifier);
    expect(kid).toBeTruthy();
    expect(payload.iss).toBe(h.issuer);
    expect(payload.aud).toBe(client.id);
    expect(payload.sub).toBe(anna.id);
    expect(payload.nonce).toBe(a.nonce);
    expect(payload.exp! - payload.iat!).toBe(300);
    expect(payload.auth_time).toBeGreaterThanOrEqual(before);
    expect(payload.auth_time).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(payload.amr).toEqual(['pwd', 'otp']);
    expect(payload.email).toBe(anna.email);
    expect(payload.name).toBe('Anna Test');
    const sessionRow = await h.prisma.portalSession.findFirstOrThrow({ where: { accountId: anna.id }, orderBy: { createdAt: 'desc' } });
    expect(payload.sid).toBe(sessionRow.id);
  });

  it('roles enthält nur die Rolle dieser Verwaltung, ohne Rolle ein leeres Objekt', async () => {
    const b = h.browser();
    const first = await viaLogin(b, anna);
    const { payload } = await idTokenOf(b, client, first.code, first.pkce.verifier);
    expect(payload.roles).toEqual({ [client.id]: 'admin' });

    // Dieselbe Sitzung, andere Verwaltung: andere Rolle, keine Auskunft über die erste.
    const pkce = newPkce();
    const a = h.authorizePath(other, pkce);
    const hit = await b.get(a.path);
    const second = h.codeFrom(hit.location, other);
    const t2 = await idTokenOf(b, other, second.code, pkce.verifier);
    expect(t2.payload.roles).toEqual({ [other.id]: 'staff' });

    const nobody = await h.account();
    const b2 = h.browser();
    const r = await viaLogin(b2, nobody);
    const t3 = await idTokenOf(b2, client, r.code, r.pkce.verifier);
    expect(t3.payload.roles).toEqual({});
  });

  it('vorhandene Sitzung: kein Login-Prompt, sofort Code (auch mit großzügigem max_age)', async () => {
    const b = h.browser();
    await viaLogin(b, anna);
    for (const extra of [{} as Record<string, string>, { max_age: "3600" }]) {
      const pkce = newPkce();
      const a = h.authorizePath(client, pkce, extra);
      const res = await b.get(a.path);
      expect(res.status).toBe(302);
      const { code, state } = h.codeFrom(res.location, client);
      expect(state).toBe(a.state);
      const { payload } = await idTokenOf(b, client, code, pkce.verifier);
      expect(payload.nonce).toBe(a.nonce);
    }
  });

  it('max_age=0 erzwingt einen neuen Faktor: frische auth_time, gleiche sid', async () => {
    const b = h.browser();
    const first = await viaLogin(b, anna);
    const t1 = await idTokenOf(b, client, first.code, first.pkce.verifier);

    await sleep(1100); // auth_time hat Sekunden-Auflösung
    const pkce = newPkce();
    const a = h.authorizePath(client, pkce, { max_age: '0' });
    const res = await b.get(a.path);
    expect(res.status).toBe(302);
    const login = new URL(res.location!);
    expect(`${login.origin}${login.pathname}`).toBe(`${h.issuer}/auth/login`);
    expect(login.searchParams.get('stepup')).toBe('1');
    const req = login.searchParams.get('req')!;

    // Ohne neuen Faktor gibt es KEINEN Code, auch nicht über den Rückkehrlink.
    const sneaky = await b.get(`/oauth/authorize/continue?req=${req}`);
    expect(sneaky.status).toBe(302);
    expect(sneaky.location).toContain('/auth/login');

    const done = await h.login(b, anna, { req });
    expect(done.status).toBe(200);
    expect(done.body.amr).toEqual(['pwd', 'otp']);
    const back = await b.get(done.body.next);
    const { code } = h.codeFrom(back.location, client);
    const t2 = await idTokenOf(b, client, code, pkce.verifier);
    expect(t2.payload.auth_time).toBeGreaterThan(t1.payload.auth_time as number);
    expect(t2.payload.sid).toBe(t1.payload.sid);
    expect(t2.payload.amr).toEqual(['pwd', 'otp']);

    // Die Anfrage ist verbraucht.
    const again = await b.get(done.body.next);
    expect(again.status).toBe(400);
  });

  it('Step-up gilt nur für dasselbe Konto; prompt=login und abgelaufenes max_age verlangen ebenfalls einen Faktor', async () => {
    const b = h.browser();
    await viaLogin(b, anna);
    const bob = await h.account();

    const a = h.authorizePath(client, newPkce(), { prompt: 'login' });
    const res = await b.get(a.path);
    const req = new URL(res.location!).searchParams.get('req')!;
    expect(new URL(res.location!).searchParams.get('stepup')).toBe('1');
    const wrong = await h.login(b, bob, { req });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toBe('step_up_wrong_account');

    // max_age=1 nach 1,2 s Wartezeit: überschritten.
    await sleep(1200);
    const old = await b.get(h.authorizePath(client, newPkce(), { max_age: '1' }).path);
    expect(new URL(old.location!).searchParams.get('stepup')).toBe('1');
  });

  it('prompt=none ohne Sitzung: login_required an die Verwaltung', async () => {
    const b = h.browser();
    const a = h.authorizePath(client, newPkce(), { prompt: 'none' });
    const res = await b.get(a.path);
    const url = new URL(res.location!);
    expect(url.origin + url.pathname).toBe(client.redirectUri);
    expect(url.searchParams.get('error')).toBe('login_required');
    expect(url.searchParams.get('state')).toBe(a.state);
  });

  it('amr hwk (Passkey) wird unverändert ins Token übernommen', async () => {
    const { SessionsService } = await import('../sessions/sessions.service');
    const account = await h.prisma.account.findUniqueOrThrow({ where: { id: anna.id } });
    const created = await h.app.get(SessionsService).create(account, ['hwk']);
    const b = h.browser();
    b.cookies.set('portal_sid', created.token);
    const pkce = newPkce();
    const res = await b.get(h.authorizePath(client, pkce).path);
    const { code } = h.codeFrom(res.location, client);
    const { payload } = await idTokenOf(b, client, code, pkce.verifier);
    expect(payload.amr).toEqual(['hwk']);
    expect(payload.sid).toBe(created.session.id);
  });

  it('falscher code_verifier: invalid_grant, und der Code ist danach verbraucht', async () => {
    const b = h.browser();
    const { code, pkce } = await viaLogin(b, anna);
    const bad = await h.tokenRequest(b, client, code, newPkce().verifier);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_grant');
    const good = await h.tokenRequest(b, client, code, pkce.verifier);
    expect(good.status).toBe(400);
    expect(good.body.error).toBe('invalid_grant');
  });

  it('Code-Replay: die zweite Einlösung scheitert mit invalid_grant', async () => {
    const b = h.browser();
    const { code, pkce } = await viaLogin(b, anna);
    expect((await h.tokenRequest(b, client, code, pkce.verifier)).status).toBe(200);
    const replay = await h.tokenRequest(b, client, code, pkce.verifier);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
  });

  it('gleichzeitige Einlösung desselben Codes: genau eine gewinnt', async () => {
    const b = h.browser();
    const { code, pkce } = await viaLogin(b, anna);
    const results = await Promise.all(Array.from({ length: 6 }, () => h.tokenRequest(b, client, code, pkce.verifier)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.body?.error === 'invalid_grant')).toHaveLength(5);
  });

  it('Code läuft nach 60 Sekunden ab', async () => {
    const b = h.browser();
    const { code, pkce } = await viaLogin(b, anna);
    const { hashToken } = await import('@saas-instant/auth-core');
    const row = await h.prisma.authCode.findUniqueOrThrow({ where: { codeHash: hashToken(code) } });
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeLessThanOrEqual(60_000);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThan(55_000);
    await h.prisma.authCode.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await h.tokenRequest(b, client, code, pkce.verifier);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('falsche redirect_uri: beim Authorize 400 ohne Weiterleitung, beim Token invalid_grant', async () => {
    const b = h.browser();
    const evil = { ...client, redirectUri: 'https://boese.example.test/cb' };
    const rejected = await b.get(h.authorizePath(evil, newPkce()).path);
    expect(rejected.status).toBe(400);
    expect(rejected.location).toBeNull();
    expect(rejected.body.error).toBe('invalid_request');

    const { code, pkce } = await viaLogin(b, anna);
    const res = await h.tokenRequest(b, client, code, pkce.verifier, { redirect_uri: 'https://boese.example.test/cb' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('unbekannter Client: Authorize 400, Token invalid_client (401)', async () => {
    const b = h.browser();
    const ghost = { id: 'gibt-es-nicht', secret: 'x'.repeat(30), redirectUri: 'https://x.example.test/cb' };
    const a = await b.get(h.authorizePath(ghost, newPkce()).path);
    expect(a.status).toBe(400);
    expect(a.location).toBeNull();
    const t = await h.tokenRequest(b, ghost, 'irgendein-code', newPkce().verifier);
    expect(t.status).toBe(401);
    expect(t.body.error).toBe('invalid_client');
  });

  it('falsches Client-Secret: invalid_client, der Code bleibt einlösbar', async () => {
    const b = h.browser();
    const { code, pkce } = await viaLogin(b, anna);
    const bad = await h.tokenRequest(b, client, code, pkce.verifier, { client_secret: 'falsch-falsch-falsch-falsch-1' });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe('invalid_client');
    expect((await h.tokenRequest(b, client, code, pkce.verifier)).status).toBe(200);
  });

  it('Code gehört zu einer Verwaltung: Einlösung durch eine andere scheitert', async () => {
    const b = h.browser();
    const { code, pkce } = await viaLogin(b, anna);
    const res = await h.tokenRequest(b, other, code, pkce.verifier, { redirect_uri: other.redirectUri });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('Authorize verlangt PKCE S256, state, nonce und openid; Fehler gehen mit state an die Verwaltung', async () => {
    const b = h.browser();
    const cases: Array<[string, Record<string, string>]> = [
      ['PKCE fehlt', { code_challenge: '' }],
      ['plain', { code_challenge_method: 'plain' }],
      ['kein openid', { scope: 'profile' }],
      ['kein nonce', { nonce: '' }],
      ['falscher response_type', { response_type: 'token' }],
    ];
    for (const [label, over] of cases) {
      const a = h.authorizePath(client, newPkce(), over);
      // leere Werte entfernen, damit sie wirklich fehlen
      const url = new URL(h.base + a.path);
      for (const [k, v] of [...url.searchParams]) if (v === '') url.searchParams.delete(k);
      const res = await b.get(url.pathname + url.search);
      expect(res.status).toBe(302);
      const to = new URL(res.location!);
      expect(`${to.origin}${to.pathname}`).toBe(client.redirectUri);
      expect(to.searchParams.get('error')).toBeTruthy();
      expect(to.searchParams.get('state')).toBe(a.state);
      expect(to.searchParams.get('code')).toBeNull();
      void label;
    }
  });

  it('Abmelden: Front-Channel-Liste aller Verwaltungen dieser sid, Sitzung beendet', async () => {
    const b = h.browser();
    const first = await viaLogin(b, anna);
    const t1 = await idTokenOf(b, client, first.code, first.pkce.verifier);
    const pkce2 = newPkce();
    const hit = await b.get(h.authorizePath(other, pkce2).path);
    await idTokenOf(b, other, h.codeFrom(hit.location, other).code, pkce2.verifier);
    const sid = t1.payload.sid as string;

    const out = await b.get(`/oauth/logout?client_id=${client.id}&post_logout_redirect_uri=${encodeURIComponent(client.postLogout)}`);
    expect(out.status).toBe(200);
    expect(out.headers.get('content-type')).toContain('text/html');
    for (const c of [client, other]) {
      const expected = `${c.logout}?iss=${encodeURIComponent(h.issuer)}&amp;sid=${sid}`;
      expect(out.text).toContain(`<iframe src="${expected}"`);
    }
    expect(out.text).toContain(JSON.stringify(client.postLogout));
    expect(out.headers.get('content-security-policy')).toContain('frame-src');

    expect((await b.get('/api/me')).status).toBe(401);
    const row = await h.prisma.portalSession.findUniqueOrThrow({ where: { id: sid } });
    expect(row.revokedAt).not.toBeNull();
    // Neue Anfrage führt wieder zur Anmeldung.
    const again = await b.get(h.authorizePath(client, newPkce()).path);
    expect(new URL(again.location!).pathname).toBe('/auth/login');
  });

  it('Abmelden ohne Verwaltung in der Sitzung oder mit fremder Rückkehradresse: Weiterleitung zum Portal', async () => {
    const b = h.browser();
    await h.login(b, anna); // nur Portal-Sitzung, keine Verwaltung
    const evil = await b.get(`/oauth/logout?client_id=${client.id}&post_logout_redirect_uri=${encodeURIComponent('https://boese.example.test/')}`);
    expect(evil.status).toBe(302);
    expect(evil.location).toBe(`${h.issuer}/auth/login`);
    expect((await b.get('/api/me')).status).toBe(401);

    const b2 = h.browser();
    await h.login(b2, anna);
    const ok = await b2.get(`/oauth/logout?client_id=${client.id}&post_logout_redirect_uri=${encodeURIComponent(client.postLogout)}&state=abc`);
    expect(ok.status).toBe(302);
    expect(ok.location).toBe(`${client.postLogout}?state=abc`);
  });

  it('gesperrtes Konto: Sitzung endet sofort, Token wird nicht mehr ausgestellt', async () => {
    const carl = await h.account({ roles: { [client.id]: 'staff' } });
    const b = h.browser();
    const { code, pkce } = await viaLogin(b, carl);
    await h.prisma.account.update({ where: { id: carl.id }, data: { disabledAt: new Date() } });
    const res = await h.tokenRequest(b, client, code, pkce.verifier);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect((await b.get('/api/me')).status).toBe(401);
  });
});
