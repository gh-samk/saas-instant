import { Harness, newPkce } from '../test-support/harness';
import { SoftwareAuthenticator } from '../test-support/software-authenticator';

describe('Passkeys: Registrierung und Anmeldung (Software-Authenticator, echte Datenbank)', () => {
  const h = new Harness();
  let client: Awaited<ReturnType<Harness['client']>>;
  beforeAll(async () => {
    await h.start();
    client = await h.client(`pk-${h.runId}`);
  });
  afterAll(async () => {
    await h.prisma.oidcClient.deleteMany({ where: { id: client.id } });
    await h.cleanup();
    await h.stop();
  });

  async function registered() {
    const acc = await h.account({ roles: { [client.id]: 'staff' } });
    const authenticator = new SoftwareAuthenticator(new URL(h.issuer).hostname, h.issuer);
    const b = h.browser();
    await h.login(b, acc);
    const options = await b.post('/api/me/passkeys/options', { password: acc.password });
    expect(options.status).toBe(200);
    expect(options.body.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    const done = await b.post('/api/me/passkeys', { response: authenticator.register(options.body), label: 'Testgerät' });
    expect(done.status).toBe(200);
    return { acc, authenticator, b };
  }

  async function loginOptions(b: ReturnType<Harness['browser']>) {
    const options = await b.post('/api/auth/passkey/options', {});
    expect(options.status).toBe(200);
    expect(options.body.userVerification).toBe('required');
    expect(options.body.allowCredentials ?? []).toEqual([]); // keine Konto-Auskunft
    return options.body as { challenge: string };
  }

  it('Registrierung verlangt das Passwort; der Passkey erscheint in /api/me', async () => {
    const acc = await h.account();
    const b = h.browser();
    await h.login(b, acc);
    expect((await b.post('/api/me/passkeys/options', { password: 'falsch-falsch-123' })).status).toBe(403);
    const { b: b2, acc: acc2 } = await registered();
    const me = await b2.get('/api/me');
    expect(me.body.factors.passkeys).toHaveLength(1);
    expect(me.body.factors.passkeys[0].label).toBe('Testgerät');
    void acc2;
  });

  it('Passkey-Anmeldung: Sitzung mit amr hwk, Zähler wächst, auch im Token der Verwaltung', async () => {
    const { acc, authenticator } = await registered();
    const b = h.browser(); // frischer Browser, keine Sitzung
    const opts = await loginOptions(b);
    const res = await b.post('/api/auth/passkey/login', { response: authenticator.assert(opts) });
    expect(res.status).toBe(200);
    expect(res.body.amr).toEqual(['hwk']);
    expect((await b.get('/api/me')).body.account.email).toBe(acc.email);
    const row = await h.prisma.passkey.findFirstOrThrow({ where: { accountId: acc.id } });
    expect(row.counter).toBe(1);
    expect(row.lastUsedAt).not.toBeNull();

    const pkce = newPkce();
    const hit = await b.get(h.authorizePath(client, pkce).path);
    const { code } = h.codeFrom(hit.location, client);
    const token = await h.tokenRequest(b, client, code, pkce.verifier);
    const { payload } = await h.verifyIdToken(token.body.id_token, client.id);
    expect(payload.amr).toEqual(['hwk']);
    expect(payload.roles).toEqual({ [client.id]: 'staff' });
  });

  it('Step-up per Passkey: frische auth_time, gleiche sid', async () => {
    const { acc, authenticator } = await registered();
    const b = h.browser();
    await h.login(b, acc);
    const sid = (await h.prisma.portalSession.findFirstOrThrow({ where: { accountId: acc.id }, orderBy: { createdAt: 'desc' } })).id;
    const hit = await b.get(h.authorizePath(client, newPkce(), { max_age: '0' }).path);
    const req = new URL(hit.location!).searchParams.get('req')!;
    const opts = await loginOptions(b);
    const res = await b.post('/api/auth/passkey/login', { response: authenticator.assert(opts), req });
    expect(res.status).toBe(200);
    expect(res.body.next).toBe(`/oauth/authorize/continue?req=${req}`);
    const back = await b.get(res.body.next);
    expect(h.codeFrom(back.location, client).code).toBeTruthy();
    const after = await h.prisma.portalSession.findUniqueOrThrow({ where: { id: sid } });
    expect(after.amr).toEqual(['hwk']);
    expect(after.revokedAt).toBeNull();
    expect(await h.prisma.portalSession.count({ where: { accountId: acc.id } })).toBe(2); // die erste aus registered() bleibt unberührt
  });

  it('Challenge gilt einmal; falsche Signatur, nicht wachsender Zähler und unbekannter Passkey scheitern', async () => {
    const { authenticator, acc } = await registered();
    const b = h.browser();
    const opts = await loginOptions(b);
    const resp = authenticator.assert(opts);
    expect((await b.post('/api/auth/passkey/login', { response: resp })).status).toBe(200);
    // Replay derselben Antwort mit derselben Challenge: Challenge ist verbraucht.
    const replay = h.browser();
    replay.cookies.set('portal_wa', b.cookies.get('portal_wa') ?? 'weg');
    expect((await replay.post('/api/auth/passkey/login', { response: resp })).status).toBe(401);

    const b2 = h.browser();
    const o2 = await loginOptions(b2);
    expect((await b2.post('/api/auth/passkey/login', { response: authenticator.assert(o2, { corruptSignature: true }) })).status).toBe(401);

    const b3 = h.browser();
    const o3 = await loginOptions(b3);
    // Zähler steht bei 2 (letzte Zählung), 1 wäre ein Rückschritt.
    expect((await b3.post('/api/auth/passkey/login', { response: authenticator.assert(o3, { counter: 1 }) })).status).toBe(401);

    const stranger = new SoftwareAuthenticator(new URL(h.issuer).hostname, h.issuer);
    const b4 = h.browser();
    const o4 = await loginOptions(b4);
    expect((await b4.post('/api/auth/passkey/login', { response: stranger.assert(o4) })).status).toBe(401);

    // Ohne Challenge-Cookie
    expect((await h.browser().post('/api/auth/passkey/login', { response: authenticator.assert(o4) })).status).toBe(401);
    expect(await h.prisma.passkey.count({ where: { accountId: acc.id } })).toBe(1);
  });

  it('gesperrtes Konto: Passkey-Anmeldung abgelehnt; Entfernen verlangt das Passwort', async () => {
    const { acc, authenticator, b: owner } = await registered();
    const pk = await h.prisma.passkey.findFirstOrThrow({ where: { accountId: acc.id } });
    expect((await owner.post(`/api/me/passkeys/${pk.id}/delete`, { password: 'falsch-falsch-123' })).status).toBe(403);

    await h.prisma.account.update({ where: { id: acc.id }, data: { disabledAt: new Date() } });
    const b = h.browser();
    const opts = await loginOptions(b);
    expect((await b.post('/api/auth/passkey/login', { response: authenticator.assert(opts) })).status).toBe(401);

    await h.prisma.account.update({ where: { id: acc.id }, data: { disabledAt: null } });
    const o2 = await h.login(owner, acc);
    expect(o2.status).toBe(200);
    expect((await owner.post(`/api/me/passkeys/${pk.id}/delete`, { password: acc.password })).status).toBe(200);
    expect(await h.prisma.passkey.count({ where: { accountId: acc.id } })).toBe(0);
  });
});
