import { authenticator } from 'otplib';
import { Harness, newPkce } from '../test-support/harness';

describe('Konten, Einrichtung, Rollen und Schutz der API (echte Datenbank)', () => {
  const h = new Harness();
  let client: Awaited<ReturnType<Harness['client']>>;
  beforeAll(async () => {
    await h.start();
    client = await h.client(`acc-${h.runId}`);
  });
  afterAll(async () => {
    await h.prisma.oidcClient.deleteMany({ where: { id: client.id } });
    await h.cleanup();
    await h.stop();
  });

  it('schreibende Anfragen ohne CSRF-Nachweis oder mit fremdem Origin werden abgelehnt', async () => {
    const b = h.browser();
    const missing = await b.request('POST', '/api/auth/login', { csrf: false, json: { email: 'a@b.de', password: 'x' } });
    expect(missing.status).toBe(403);
    expect(missing.body.error).toBe('csrf_invalid');
    const evil = await b.request('POST', '/api/auth/login', {
      json: { email: 'a@b.de', password: 'x' },
      headers: { origin: 'https://boese.example.test' },
    });
    expect(evil.status).toBe(403);
    expect(evil.body.error).toBe('csrf_origin');
  });

  it('ohne Sitzung: /api/me und Verwaltungsrouten liefern 401', async () => {
    const b = h.browser();
    expect((await b.get('/api/me')).status).toBe(401);
    expect((await b.get('/api/admin/accounts')).status).toBe(401);
    expect((await b.get('/api/health')).body).toEqual({ status: 'ok' });
  });

  it('/api/me nennt Rollen je Verwaltung (Grundlage des Launchers); Nicht-Admins kommen nicht an die Kontenverwaltung', async () => {
    const staff = await h.account({ roles: { [client.id]: 'staff' } });
    const b = h.browser();
    await h.login(b, staff);
    const me = await b.get('/api/me');
    expect(me.status).toBe(200);
    expect(me.body.account).toMatchObject({ email: staff.email, portalAdmin: false });
    expect(me.body.roles).toEqual({ [client.id]: 'staff' });
    expect(me.body.factors.totp).toBe(true);
    expect(me.body.factors.recoveryCodesLeft).toBe(8);
    expect((await b.get('/api/admin/accounts')).status).toBe(403);
    expect((await b.post('/api/admin/accounts', { email: 'x@example.test', name: 'X' })).status).toBe(403);
  });

  it('Einladung: Konto anlegen, Link einrichten (Passwort + TOTP), Link nur einmal, danach Anmeldung', async () => {
    const admin = await h.account({ portalAdmin: true });
    const ab = h.browser();
    await h.login(ab, admin);
    const email = `neu-${h.runId}@example.test`;
    const created = await ab.post('/api/admin/accounts', { email, name: 'Neue Person' });
    expect(created.status).toBe(201);
    expect(created.body.account).toMatchObject({ email, setupPending: true, totp: false, disabled: false });
    const link = new URL(created.body.setupLink);
    expect(link.pathname).toBe('/auth/setup');
    const token = link.searchParams.get('token')!;

    const nb = h.browser();
    const begin = await nb.post('/api/auth/setup/begin', { token });
    expect(begin.status).toBe(200);
    expect(begin.body.email).toBe(email);
    expect(begin.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(begin.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);

    // Schwaches Passwort und falscher Code scheitern, ohne den Link zu verbrauchen.
    expect((await nb.post('/api/auth/setup/complete', { token, password: 'kurz', code: authenticator.generate(begin.body.totpSecret) })).body.error).toBe('password_weak');
    expect((await nb.post('/api/auth/setup/complete', { token, password: 'ein-langes-Passwort-1', code: '000000' })).body.error).toBe('totp_code_invalid');

    const password = 'ein-langes-Passwort-1';
    const done = await nb.post('/api/auth/setup/complete', { token, password, code: authenticator.generate(begin.body.totpSecret) });
    expect(done.status).toBe(200);
    expect(done.body.recoveryCodes).toHaveLength(8);
    expect((await nb.post('/api/auth/setup/begin', { token })).status).toBe(410);

    const lb = h.browser();
    const row = await h.prisma.account.findUniqueOrThrow({ where: { email } });
    await h.prisma.account.update({ where: { id: row.id }, data: { totpLastStep: null } });
    const login = await lb.post('/api/auth/login', { email, password, code: authenticator.generate(begin.body.totpSecret) });
    expect(login.status).toBe(200);
    expect((await lb.get('/api/me')).body.roles).toEqual({});
  });

  it('Rollen setzen und entziehen wirkt im Token der Verwaltung; Sperren beendet Sitzungen', async () => {
    const admin = await h.account({ portalAdmin: true });
    const target = await h.account({ name: 'Zielperson' });
    const ab = h.browser();
    await h.login(ab, admin);

    const clients = await ab.get('/api/admin/clients');
    expect(clients.body.clients.map((c: { id: string }) => c.id)).toContain(client.id);

    const set = await ab.post(`/api/admin/accounts/${target.id}/roles`, { clientId: client.id, role: 'staff' });
    expect(set.status).toBe(200);
    expect(set.body.account.roles).toEqual({ [client.id]: 'staff' });
    expect((await ab.post(`/api/admin/accounts/${target.id}/roles`, { clientId: client.id, role: 'chef' })).status).toBe(400);
    expect((await ab.post(`/api/admin/accounts/${target.id}/roles`, { clientId: 'unbekannt', role: 'admin' })).status).toBe(404);

    const tb = h.browser();
    await h.login(tb, target);
    const pkce = newPkce();
    const hit = await tb.get(h.authorizePath(client, pkce).path);
    const { code } = h.codeFrom(hit.location, client);
    const token = await h.tokenRequest(tb, client, code, pkce.verifier);
    expect((await h.verifyIdToken(token.body.id_token, client.id)).payload.roles).toEqual({ [client.id]: 'staff' });

    await ab.post(`/api/admin/accounts/${target.id}/roles`, { clientId: client.id, role: 'none' });
    expect((await tb.get('/api/me')).body.roles).toEqual({});

    expect((await ab.post(`/api/admin/accounts/${target.id}/disable`)).status).toBe(200);
    expect((await tb.get('/api/me')).status).toBe(401);
    expect((await ab.post(`/api/admin/accounts/${admin.id}/disable`)).status).toBe(409);
    expect((await ab.post(`/api/admin/accounts/${admin.id}/portal-admin`, { value: false })).status).toBe(409);
    expect((await ab.post(`/api/admin/accounts/${target.id}/enable`)).body.account.disabled).toBe(false);
  });

  it('Zurücksetzen: neuer Link ersetzt Passwort und Faktoren, alte Sitzungen und Passkeys enden', async () => {
    const admin = await h.account({ portalAdmin: true });
    const victim = await h.account();
    const vb = h.browser();
    await h.login(vb, victim);
    await h.prisma.passkey.create({
      data: { accountId: victim.id, credentialId: `c-${h.runId}`, publicKey: 'AAAA', label: 'Test' },
    });
    const ab = h.browser();
    await h.login(ab, admin);
    const link = (await ab.post(`/api/admin/accounts/${victim.id}/setup-link`)).body.setupLink as string;
    const token = new URL(link).searchParams.get('token')!;
    const begin = await h.browser().post('/api/auth/setup/begin', { token });
    expect(begin.body.purpose).toBe('reset');
    const newPassword = 'neues-langes-Passwort-2';
    const done = await h.browser().post('/api/auth/setup/complete', { token, password: newPassword, code: authenticator.generate(begin.body.totpSecret) });
    expect(done.status).toBe(200);
    expect((await vb.get('/api/me')).status).toBe(401);
    expect(await h.prisma.passkey.count({ where: { accountId: victim.id } })).toBe(0);
    expect((await h.login(h.browser(), victim)).status).toBe(401); // altes Passwort
  });

  it('Passwortwechsel verlangt das aktuelle Passwort und beendet andere Sitzungen', async () => {
    const a = await h.account();
    const b1 = h.browser();
    const b2 = h.browser();
    await h.login(b1, a);
    await h.login(b2, a);
    // zwei Browser, gleiche Konto-Sitzung? Der zweite Login ersetzt nichts: eigene Cookies, eigene Sitzung.
    expect((await b1.post('/api/me/password', { currentPassword: 'falsch-falsch-1', newPassword: 'ganz-neues-Passwort-3' })).status).toBe(403);
    const ok = await b1.post('/api/me/password', { currentPassword: a.password, newPassword: 'ganz-neues-Passwort-3' });
    expect(ok.status).toBe(200);
    expect((await b1.get('/api/me')).status).toBe(200);
    expect((await b2.get('/api/me')).status).toBe(401);
  });

  it('Authorize ohne Sitzung führt nur zur Anmeldeseite des Portals, nie zur Verwaltung', async () => {
    const res = await h.browser().get(h.authorizePath(client, newPkce()).path);
    expect(res.status).toBe(302);
    expect(res.location!.startsWith(`${h.issuer}/auth/login?req=`)).toBe(true);
  });
});
