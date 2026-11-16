import { Reflector } from '@nestjs/core';
import { LoginFailedError } from '../errors/business-error';
import { buildLogin, TEST_PASSWORD } from '../../test-support/login-provisioning';
import { WITHOUT_SECOND_FACTOR } from '../decorators/without-second-factor.decorator';
import { SecondFactorGuard } from './second-factor.guard';

// argon2 ist absichtlich langsam.
jest.setTimeout(60_000);

/**
 * [K4] — die Nachweispflicht wird jetzt DEKLARATIV durchgesetzt. Diese Tests
 * prüfen die Durchsetzung an der Stelle, an der sie stattfindet: im Guard.
 */
describe('SecondFactorGuard', () => {
  /** Baut Guard und Kontext um einen Benutzer und einen Body herum. */
  async function build(options: {
    body?: unknown;
    headers?: Record<string, string>;
    evidenceAt?: Date | null;
    exception?: string;
    withoutUser?: boolean;
  }) {
    const provisioning = await buildLogin({ loginCodeEnabled: true });
    const reflector = {
      get: () => options.exception,
    } as unknown as Reflector;
    const guard = new SecondFactorGuard(reflector, provisioning.access);
    const req = {
      user: options.withoutUser ? undefined : provisioning.sessionUser,
      sessionEvidenceAt: options.evidenceAt ?? null,
      body: options.body,
      ip: '203.0.113.5',
      headers: { 'user-agent': 'Jest', ...(options.headers ?? {}) },
    };
    const context = {
      getHandler: () => () => undefined,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
    };
    return { guard, context, provisioning };
  }

  it('weist eine gealterte Sitzung ohne Nachweis ab', async () => {
    const { guard, context } = await build({
      body: {},
      evidenceAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(
      LoginFailedError,
    );
  });

  it('weist einen FALSCHEN Nachweis ab und zählt den Fehlversuch', async () => {
    const { guard, context, provisioning } = await build({
      body: { currentPassword: 'wrong' },
      evidenceAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(
      LoginFailedError,
    );
    expect(provisioning.data.user[0].failedAttempts).toBe(1);
  });

  it('lässt das richtige Passwort durch', async () => {
    const { guard, context } = await build({
      body: { currentPassword: TEST_PASSWORD },
      evidenceAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    await expect(guard.canActivate(context as never)).resolves.toBe(true);
  });

  // [M12] Logo-Upload (rohes Bild) und -Entfernen (kein Body) tragen den
  // Nachweis im Kopf `x-second-factor` (Base64 eines JSON).
  const header = (evidence: object): string =>
    Buffer.from(JSON.stringify(evidence), 'utf8').toString('base64');

  it('nimmt den Nachweis aus dem Kopf, wenn der Body keinen trägt', async () => {
    const { guard, context } = await build({
      body: {},
      headers: { 'x-second-factor': header({ currentPassword: TEST_PASSWORD }) },
      evidenceAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    await expect(guard.canActivate(context as never)).resolves.toBe(true);
  });

  it('weist einen falschen oder unlesbaren Nachweis im Kopf ab', async () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
    for (const value of [header({ currentPassword: 'wrong' }), '%%%kein-base64%%%', header([])]) {
      const { guard, context } = await build({
        body: {},
        headers: { 'x-second-factor': value },
        evidenceAt: stale,
      });
      await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(
        LoginFailedError,
      );
    }
  });

  it('lässt eine FRISCHE Sitzung ohne Nachweis durch (Ersteinrichtung)', async () => {
    const { guard, context } = await build({ body: {}, evidenceAt: new Date() });

    await expect(guard.canActivate(context as never)).resolves.toBe(true);
  });

  it('behandelt eine Sitzung ohne Nachweiszeitpunkt als nicht frisch', async () => {
    const { guard, context } = await build({ body: {}, evidenceAt: null });

    await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(
      LoginFailedError,
    );
  });

  it('lässt eine ausdrücklich ausgenommene Route ohne alles durch', async () => {
    const { guard, context } = await build({
      body: {},
      evidenceAt: null,
      exception: 'Lesend.',
    });

    await expect(guard.canActivate(context as never)).resolves.toBe(true);
  });

  it('glaubt einem Body nichts, was keine Zeichenkette ist', async () => {
    // Guards laufen VOR der ValidationPipe; der Body ist hier ungeprüft.
    const { guard, context } = await build({
      body: { currentPassword: { toString: () => TEST_PASSWORD } },
      evidenceAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(
      LoginFailedError,
    );
  });

  it('bricht laut ab, wenn der SitzungGuard fehlt', async () => {
    // Sonst wäre die Route unbemerkt ungeschützt.
    const { guard, context } = await build({ body: {}, withoutUser: true });

    await expect(guard.canActivate(context as never)).rejects.toThrow(
      /SitzungGuard/,
    );
  });

  it('benutzt denselben Metadatenschlüssel wie der Decorator', () => {
    expect(WITHOUT_SECOND_FACTOR).toBe('withoutSecondFactor');
  });
});
