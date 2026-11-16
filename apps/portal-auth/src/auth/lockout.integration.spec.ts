import { authenticator } from 'otplib';
import { Harness, TestAccount } from '../test-support/harness';

describe('Anmeldung, Sperre und Faktoren (echte Datenbank)', () => {
  const h = new Harness();
  beforeAll(() => h.start());
  afterAll(async () => {
    await h.cleanup();
    await h.stop();
  });

  const wrong = (b: ReturnType<Harness['browser']>, a: TestAccount, over: Record<string, unknown> = {}) =>
    b.post('/api/auth/login', { email: a.email, password: 'falsches-Passwort-123', code: '000000', ...over });

  it('fünf Fehlversuche sperren das Konto; auch das richtige Passwort kommt dann nicht durch', async () => {
    const a = await h.account();
    const b = h.browser();
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await wrong(b, a)).status);
    expect(statuses).toEqual([401, 401, 401, 401, 429]);

    const row = await h.prisma.account.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.failedAttempts).toBe(5);
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 14 * 60 * 1000);

    const blocked = await h.login(b, a);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('account_locked');
    expect(blocked.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.body.retryAfterSeconds).toBeLessThanOrEqual(900);
    expect(await h.prisma.portalSession.count({ where: { accountId: a.id } })).toBe(0);

    const locked = await h.prisma.auditEntry.count({ where: { accountId: a.id, action: 'login.locked' } });
    expect(locked).toBe(1);
  });

  it('nach Ablauf der Sperre geht die Anmeldung wieder und der Zähler steht auf 0', async () => {
    const a = await h.account();
    const b = h.browser();
    for (let i = 0; i < 5; i++) await wrong(b, a);
    await h.prisma.account.update({ where: { id: a.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    const ok = await h.login(b, a);
    expect(ok.status).toBe(200);
    const row = await h.prisma.account.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.failedAttempts).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });

  it('abgelaufene Sperre + neuer Fehlversuch beginnt wieder bei 1', async () => {
    const a = await h.account();
    const b = h.browser();
    for (let i = 0; i < 5; i++) await wrong(b, a);
    await h.prisma.account.update({ where: { id: a.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    expect((await wrong(b, a)).status).toBe(401);
    const row = await h.prisma.account.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.failedAttempts).toBe(1);
    expect(row.lockedUntil).toBeNull();
  });

  it('gleichzeitige Fehlversuche gehen nicht verloren (atomares UPDATE)', async () => {
    const a = await h.account();
    const browsers = Array.from({ length: 8 }, () => h.browser());
    await Promise.all(browsers.map((b) => wrong(b, a)));
    const row = await h.prisma.account.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.failedAttempts).toBe(8);
    expect(row.lockedUntil).not.toBeNull();
    expect(await h.prisma.auditEntry.count({ where: { accountId: a.id, action: 'login.locked' } })).toBe(1);
  });

  it('falscher Code zählt, fehlender Code nicht; unbekannte Kennung ist von falschem Passwort nicht zu unterscheiden', async () => {
    const a = await h.account();
    const b = h.browser();
    const noCode = await b.post('/api/auth/login', { email: a.email, password: a.password });
    expect(noCode.status).toBe(401);
    expect(noCode.body.error).toBe('code_required');
    expect((await h.prisma.account.findUniqueOrThrow({ where: { id: a.id } })).failedAttempts).toBe(0);

    const badCode = await b.post('/api/auth/login', { email: a.email, password: a.password, code: '123456' });
    expect(badCode.status).toBe(401);
    expect((await h.prisma.account.findUniqueOrThrow({ where: { id: a.id } })).failedAttempts).toBe(1);

    const unknown = await b.post('/api/auth/login', { email: 'niemand@example.test', password: 'egal-egal-egal-1', code: '123456' });
    const badPw = await wrong(b, a, { code: undefined });
    expect(unknown.status).toBe(401);
    expect(badPw.status).toBe(401);
    expect(unknown.body).toEqual(badPw.body);
  });

  it('TOTP-Replay: derselbe Code gilt nur einmal', async () => {
    const a = await h.account();
    await h.prisma.account.update({ where: { id: a.id }, data: { totpLastStep: null } });
    const code = authenticator.generate(a.secret);
    const b1 = h.browser();
    const first = await b1.post('/api/auth/login', { email: a.email, password: a.password, code });
    expect(first.status).toBe(200);
    const second = await h.browser().post('/api/auth/login', { email: a.email, password: a.password, code });
    expect(second.status).toBe(401);
    expect(second.body.error).toBe('invalid_credentials');
  });

  it('Wiederherstellungscode: einmal nutzbar, danach verbraucht', async () => {
    const a = await h.account();
    const recovery = a.recoveryCodes[0];
    const first = await h.browser().post('/api/auth/login', { email: a.email, password: a.password, code: recovery });
    expect(first.status).toBe(200);
    const second = await h.browser().post('/api/auth/login', { email: a.email, password: a.password, code: recovery });
    expect(second.status).toBe(401);
    expect(await h.prisma.recoveryCode.count({ where: { accountId: a.id, consumedAt: null } })).toBe(a.recoveryCodes.length - 1);
  });

  it('gesperrtes (deaktiviertes) Konto kann sich nicht anmelden', async () => {
    const a = await h.account();
    await h.prisma.account.update({ where: { id: a.id }, data: { disabledAt: new Date() } });
    const res = await h.login(h.browser(), a);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('Sitzungscookie ist HttpOnly mit SameSite=Lax; eine neue Anmeldung ersetzt die alte Sitzung', async () => {
    const a = await h.account();
    const b = h.browser();
    const first = await h.login(b, a);
    const cookie = first.headers.getSetCookie().find((c) => c.startsWith('portal_sid='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const firstToken = b.cookies.get('portal_sid');
    const me1 = await b.get('/api/me');
    expect(me1.status).toBe(200);
    const sidBefore = (await h.prisma.portalSession.findMany({ where: { accountId: a.id } }))[0].id;

    // Gleiches Konto, gleicher Browser: Step-up behält die sid, tauscht aber den Cookie-Wert (Session-Fixation).
    await h.login(b, a);
    expect(b.cookies.get('portal_sid')).not.toBe(firstToken);
    const sessions = await h.prisma.portalSession.findMany({ where: { accountId: a.id } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(sidBefore);
  });

  it('Ratenbegrenzung der Anmeldung greift je Adresse', async () => {
    const { RateLimiter } = await import('../common/rate-limiter');
    const limiter = new RateLimiter();
    const results = Array.from({ length: 22 }, () => limiter.take('login:1.2.3.4', 20, 60_000));
    expect(results.filter(Boolean)).toHaveLength(20);
    expect(limiter.take('login:5.6.7.8', 20, 60_000)).toBe(true);
  });
});
