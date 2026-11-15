import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuditService } from '../audit/audit.service';
import {
  SESSION_RENEWAL_AFTER_MS,
  SESSION_MAX_AGE_MS,
  sessionCookieOptions,
} from '../common/cookies';
import { SessionGuard } from '../common/guards/session.guard';
import { buildUser, buildDouble } from '../test-support/prisma-double';
import { buildConfig } from '../test-support/login-provisioning';
import {
  assertJwtSecret,
  SessionService,
} from './session.service';

const SECRET = 'testgeheimnis';
const DAY_MS = 24 * 60 * 60 * 1000;

function build() {
  const user = buildUser();
  const { prisma, store: data } = buildDouble({ user: [user] });
  const config = buildConfig();
  const service = new SessionService(
    new JwtService({ secret: SECRET }),
    config,
    prisma,
  );
  return { service, user, data, config, prisma };
}

describe('Sitzungsdauer', () => {
  it('gilt 30 Tage — Cookie und Token mit derselben Frist', async () => {
    expect(SESSION_MAX_AGE_MS).toBe(30 * DAY_MS);

    const { service, user, config } = build();
    const token = await service.createToken(user.id);
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    ) as { iat: number; exp: number };

    expect(payload.exp - payload.iat).toBe(SESSION_MAX_AGE_MS / 1000);
    expect(sessionCookieOptions(config).maxAge).toBe(SESSION_MAX_AGE_MS);
  });

  it('behält SameSite=Strict und httpOnly', () => {
    const options = sessionCookieOptions(buildConfig());
    expect(options.sameSite).toBe('strict');
    expect(options.httpOnly).toBe(true);
  });
});

describe('Selbsterneuernde Sitzung', () => {
  it('erneuert NICHT bei jedem Request — erst ab einem Tag', () => {
    const { service } = build();
    const now = new Date('2026-08-30T12:00:00Z');

    expect(SESSION_RENEWAL_AFTER_MS).toBe(DAY_MS);
    expect(service.needsRenewal(now, now)).toBe(false);
    expect(
      service.needsRenewal(new Date(now.getTime() - 60_000), now),
    ).toBe(false);
    expect(
      service.needsRenewal(new Date(now.getTime() - DAY_MS + 1000), now),
    ).toBe(false);
  });

  it('erneuert, sobald das Token älter als ein Tag ist', () => {
    const { service } = build();
    const now = new Date('2026-08-30T12:00:00Z');

    expect(
      service.needsRenewal(new Date(now.getTime() - DAY_MS), now),
    ).toBe(true);
    expect(
      service.needsRenewal(new Date(now.getTime() - 20 * DAY_MS), now),
    ).toBe(true);
  });

  it('erneuert ein Token OHNE Ausstellungszeitpunkt nicht', () => {
    // Im Zweifel nicht verlängern — sonst hinge die Lebensdauer an einem Wert,
    // den das Token gar nicht mitbringt.
    const { service } = build();
    expect(service.needsRenewal(null)).toBe(false);
  });
});

describe('SitzungGuard erneuert das Cookie', () => {
  /** Baut einen ExecutionContext-Ersatz um Request und Response herum. */
  function buildContext(cookies: Record<string, string>) {
    const set: { name: string; value: string }[] = [];
    const req = {
      cookies,
      ip: '203.0.113.7',
      headers: { 'user-agent': 'Jest' },
    };
    const res = {
      cookie: (name: string, value: string) => set.push({ name, value }),
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    };
    return { context, set, req };
  }

  async function buildGuard() {
    const { service, user, data, config, prisma } = build();
    const guard = new SessionGuard(service, config, new AuditService(prisma));
    return { guard, service, user, data };
  }

  it('lässt ein frisches Token unangetastet', async () => {
    const { guard, service, user } = await buildGuard();
    const token = await service.createToken(user.id);
    const { context, set } = buildContext({ session: token });

    await guard.canActivate(context as never);

    expect(set).toHaveLength(0);
  });

  it('setzt bei einem gealterten Token ein neues Cookie und protokolliert das', async () => {
    const { guard, user, data } = await buildGuard();
    // Token von vor zwei Tagen: von Hand signiert, damit `iat` alt ist.
    const jwt = new JwtService({ secret: SECRET });
    const beforeTwoDays = Math.floor((Date.now() - 2 * DAY_MS) / 1000);
    const token = await jwt.signAsync(
      { sub: user.id, gen: 0, iat: beforeTwoDays, sst: beforeTwoDays },
      { secret: SECRET, expiresIn: `${SESSION_MAX_AGE_MS / 1000}s` },
    );
    const { context, set } = buildContext({ session: token });

    await guard.canActivate(context as never);

    expect(set).toHaveLength(1);
    expect(set[0].name).toBe('session');
    expect(set[0].value).not.toBe(token);
    expect(data.audit.some((entry) => entry.action === 'session.renewed')).toBe(true);
  });

  it('[K1] traegt den Nachweiszeitpunkt UNVERAENDERT ins erneuerte Token', async () => {
    // Der Kern von [K1]. Vorher hing das Frische-Fenster an `iat`; die
    // Erneuerung schrieb ein frisches `iat`, und beim NAECHSTEN Request las
    // `loeseAuf` genau das. Ein einziges harmloses GET machte damit eine 25
    // Stunden alte Sitzung wieder „frisch".
    const { guard, service, user } = await buildGuard();
    const jwt = new JwtService({ secret: SECRET });
    const issued = Math.floor((Date.now() - 2 * DAY_MS) / 1000);
    const evidence = Math.floor((Date.now() - 3 * DAY_MS) / 1000);
    const token = await jwt.signAsync(
      { sub: user.id, gen: 0, auth_time: evidence, iat: issued, sst: issued },
      { secret: SECRET, expiresIn: `${SESSION_MAX_AGE_MS / 1000}s` },
    );
    const { context, set, req } = buildContext({ session: token });

    await guard.canActivate(context as never);

    // Innerhalb dieses Requests …
    const attached = req as unknown as { sessionEvidenceAt?: Date | null };
    expect(attached.sessionEvidenceAt?.getTime()).toBe(evidence * 1000);

    // … UND im neu gesetzten Cookie, das der naechste Request liest.
    expect(set).toHaveLength(1);
    const renewed = await service.resolve(set[0].value);
    expect(renewed.evidenceAt?.getTime()).toBe(evidence * 1000);
    // `iat` wandert dagegen sehr wohl nach vorn — sonst wuerde die Sitzung nie
    // wirklich verlaengert.
    expect(renewed.issuedAt!.getTime()).toBeGreaterThan(
      issued * 1000,
    );
  });

  it('[K1] macht ein Token OHNE Nachweiszeitpunkt durch Erneuerung nicht frisch', async () => {
    const { guard, service, user } = await buildGuard();
    const jwt = new JwtService({ secret: SECRET });
    const token = await jwt.signAsync(
      {
        sub: user.id,
        gen: 0,
        iat: Math.floor((Date.now() - 2 * DAY_MS) / 1000),
        sst: Math.floor((Date.now() - 2 * DAY_MS) / 1000),
      },
      { secret: SECRET, expiresIn: `${SESSION_MAX_AGE_MS / 1000}s` },
    );
    const { context, set } = buildContext({ session: token });

    await guard.canActivate(context as never);

    const renewed = await service.resolve(set[0].value);
    expect(renewed.evidenceAt).toBeNull();
  });

  it('[K1] setzt den Nachweiszeitpunkt bei einer ECHTEN Anmeldung sehr wohl neu', async () => {
    const { service, user } = build();
    const before = Date.now();

    const token = await service.createToken(user.id);

    const resolved = await service.resolve(token);
    expect(resolved.evidenceAt).not.toBeNull();
    expect(resolved.evidenceAt!.getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    );
  });

  it('[W3] weist ein Token ohne `sub` mit 401 ab statt mit 500', async () => {
    // Ein anonym beschaffbarer Vorgangstoken traegt `benutzerId`, kein `sub`.
    // Ohne Pruefung ging der in die Datenbankabfrage und erzeugte einen
    // PrismaClientValidationError.
    const { service } = build();
    const jwt = new JwtService({ secret: SECRET });
    const flowLike = await jwt.signAsync(
      { type: 'passkey-login', userId: null, challenge: 'abc' },
      { secret: SECRET, expiresIn: '600s' },
    );

    await expect(service.resolve(flowLike)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('erneuert eine per Generation entwertete Sitzung nicht — sie ist ungültig', async () => {
    const { guard, user, data } = await buildGuard();
    const jwt = new JwtService({ secret: SECRET });
    const old = Math.floor((Date.now() - 2 * DAY_MS) / 1000);
    const token = await jwt.signAsync(
      { sub: user.id, gen: 0, iat: old, sst: old },
      { secret: SECRET, expiresIn: `${SESSION_MAX_AGE_MS / 1000}s` },
    );
    data.user[0].sessionGeneration = 1;
    const { context, set } = buildContext({ session: token });

    await expect(guard.canActivate(context as never)).rejects.toThrow();
    expect(set).toHaveLength(0);
  });
});

describe('[F7] JWT-Geheimnis', () => {
  const env = process.env['NODE_ENV'];
  afterEach(() => {
    process.env['NODE_ENV'] = env;
  });

  it('weist zu kurze und Platzhalter-Geheimnisse außerhalb von test ab', () => {
    process.env['NODE_ENV'] = 'production';
    expect(() => assertJwtSecret(undefined)).toThrow();
    expect(() => assertJwtSecret('kurz')).toThrow(/zu schwach/);
    expect(() => assertJwtSecret('change-me-example-jwt-secret')).toThrow(
      /zu schwach/,
    );
    expect(() => assertJwtSecret('x'.repeat(32))).not.toThrow();
  });

  it('lässt in NODE_ENV=test kurze Werte zu', () => {
    process.env['NODE_ENV'] = 'test';
    expect(assertJwtSecret('testgeheimnis')).toBe('testgeheimnis');
  });
});

describe('[F8] Absolute Sitzungsobergrenze', () => {
  it('weist ein Token ab, dessen Sitzungsbeginn länger als 90 Tage zurückliegt', async () => {
    const { service, user } = build();
    const jwt = new JwtService({ secret: SECRET });
    const start = Math.floor((Date.now() - 91 * DAY_MS) / 1000);
    const token = await jwt.signAsync(
      { sub: user.id, gen: 0, sst: start },
      { secret: SECRET, expiresIn: '60s' },
    );
    await expect(service.resolve(token)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('erneuert den Sitzungsbeginn nicht und verweigert die Erneuerung nach der Obergrenze', async () => {
    const { service, user } = build();
    const started = new Date(Date.now() - 10 * DAY_MS);
    const token = await service.createToken(user.id, undefined, started);
    const resolved = await service.resolve(token);
    expect(resolved.sessionStartedAt.getTime()).toBe(
      Math.floor(started.getTime() / 1000) * 1000,
    );
    await expect(
      service.createToken(user.id, undefined, new Date(Date.now() - 91 * DAY_MS)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('entwertet das Token nach dem Abmelden (Generation hochgezählt)', async () => {
    const { service, user } = build();
    const token = await service.createToken(user.id);
    await service.invalidateAllSessions(user.id);
    await expect(service.resolve(token)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
