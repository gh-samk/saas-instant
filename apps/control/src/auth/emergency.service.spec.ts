import * as argon2 from 'argon2';
import { LoginFailedError } from '../common/errors/business-error';
import { EMERGENCY_VALID_MS } from './emergency.service';
import {
  buildLogin,
  TEST_PASSWORD,
  totpCode,
} from '../test-support/login-provisioning';

jest.setTimeout(30_000);

const SOURCE = { ip: '203.0.113.13', userAgent: 'Jest' };
const NEW_PASSWORD = 'ein-frisch-gesetztes-passwort';

describe('NotfallService — Link zum Setzen eines neuen Passworts', () => {
  it('gibt einen Link aus und NIEMALS ein Passwort', async () => {
    const { emergency, data } = await buildLogin();

    const link = await emergency.generateLink('sam', 'password', 'cli:testlauf');

    expect(link.kind).toBe('password');
    expect(link.url).toContain('/emergency-password?token=');
    // Weder das bestehende Passwort noch dessen Hash tauchen im Link auf.
    expect(link.url).not.toContain(TEST_PASSWORD);
    expect(link.url).not.toContain(data.user[0].passwordHash);

    // Auch im Audit-Log steht kein Geheimnis — nur die Tatsache.
    const entry = data.audit.find(
      (line) => line.action === 'emergency.password.generated',
    );
    expect(entry?.actor).toBe('cli:testlauf');
    expect(entry?.afterValue).toEqual({
      kind: 'password',
      forAccount: 'sam',
      validMinutes: 15,
    });
    const everything = JSON.stringify(data.audit);
    expect(everything).not.toContain(TEST_PASSWORD);
    expect(everything).not.toContain(data.emergency[0].tokenHash);
  });

  it('löst den Kontonamen wahlweise über Nutzername oder E-Mail auf', async () => {
    const { emergency } = await buildLogin();

    await expect(
      emergency.generateLink('INHABER@example.com', 'password', 'cli:testlauf'),
    ).resolves.toMatchObject({ kind: 'password' });
    await expect(
      emergency.generateLink('gibtsnicht', 'password', 'cli:testlauf'),
    ).rejects.toThrow(/Kennung "gibtsnicht"/);
  });

  it('setzt das neue Passwort, entwertet den Link und alle Merk-Geräte', async () => {
    const { service, emergency, data, secret, devices, user } =
      await buildLogin();

    // Erst ein Merk-Gerät erzeugen, damit die Entwertung nachweisbar ist.
    await devices.remember(user.id, 'Merk-Gerät · Test');
    expect(data.devices).toHaveLength(1);

    const link = await emergency.generateLink('sam', 'password', 'cli:testlauf');
    const token = new URL(link.url).searchParams.get('token');
    if (!token) throw new Error('Token fehlt im Link');

    const result = await emergency.setPassword(token, NEW_PASSWORD, SOURCE);
    expect(result.username).toBe('sam');
    expect(data.devices).toHaveLength(0);

    // Das alte Passwort greift nicht mehr, das neue schon.
    await expect(
      service.passwordLogin('sam', TEST_PASSWORD, undefined, SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);
    const step1 = await service.passwordLogin(
      'sam',
      NEW_PASSWORD,
      undefined,
      SOURCE,
    );
    // Das neue Passwort ist Faktor EINS — der zweite Faktor bleibt Pflicht.
    expect(step1.kind).toBe('second-factor');
    if (step1.kind !== 'second-factor') throw new Error('unerwartet');
    const done = await service.secondFactorTotp(
      step1.flowToken,
      totpCode(secret),
      false,
      SOURCE,
    );
    expect(done.kind).toBe('session');
  });

  it('schreibt bei der Passwortänderung nur die Tatsache ins Audit-Log', async () => {
    const { emergency, data } = await buildLogin();
    const link = await emergency.generateLink('sam', 'password', 'cli:testlauf');
    const token = new URL(link.url).searchParams.get('token') as string;

    await emergency.setPassword(token, NEW_PASSWORD, SOURCE);

    const entry = data.audit.find(
      (line) => line.action === 'password.set',
    );
    expect(entry?.beforeValue).toEqual({ updated: false });
    expect(entry?.afterValue).toEqual({
      updated: true,
      viaEmergencyLink: true,
      invalidatedTrustedDevices: 0,
    });

    const everything = JSON.stringify(data.audit);
    expect(everything).not.toContain(NEW_PASSWORD);
    expect(everything).not.toContain(data.user[0].passwordHash);
    expect(await argon2.verify(data.user[0].passwordHash as string, NEW_PASSWORD)).toBe(true);
  });

  it('lässt denselben Link kein zweites Mal einlösen', async () => {
    const { emergency } = await buildLogin();
    const link = await emergency.generateLink('sam', 'password', 'cli:testlauf');
    const token = new URL(link.url).searchParams.get('token') as string;

    await emergency.setPassword(token, NEW_PASSWORD, SOURCE);
    await expect(
      emergency.setPassword(token, 'noch-ein-anderes-passwort', SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);
  });

  it('weist einen abgelaufenen Link ab', async () => {
    const { emergency } = await buildLogin();
    const earlier = new Date(Date.now() - EMERGENCY_VALID_MS - 1000);
    const link = await emergency.generateLink(
      'sam',
      'password',
      'cli:testlauf',
      earlier,
    );
    const token = new URL(link.url).searchParams.get('token') as string;

    expect(await emergency.check(token, 'password')).toBeNull();
  });

  it('liefert Restsekunden für den Countdown auf der Notfallseite', async () => {
    const { emergency } = await buildLogin();
    const link = await emergency.generateLink('sam', 'password', 'cli:testlauf');
    const token = new URL(link.url).searchParams.get('token') as string;

    const fresh = await emergency.check(token, 'password');
    // 15 Minuten, abzüglich der Zeit fürs Erzeugen — aufgerundet auf Sekunden.
    expect(fresh?.secondsRemaining).toBeGreaterThan(890);
    expect(fresh?.secondsRemaining).toBeLessThanOrEqual(900);

    // Zehn Minuten später sind es rund fünf Minuten.
    const later = new Date(Date.now() + 10 * 60 * 1000);
    const rest = await emergency.check(token, 'password', later);
    expect(rest?.secondsRemaining).toBeGreaterThan(290);
    expect(rest?.secondsRemaining).toBeLessThanOrEqual(300);
  });

  it('liefert nach Ablauf nichts mehr — es gibt dann nichts herunterzuzählen', async () => {
    const { emergency } = await buildLogin();
    const link = await emergency.generateLink('sam', 'password', 'cli:testlauf');
    const token = new URL(link.url).searchParams.get('token') as string;

    const exactAtEnd = new Date(link.expiresAt.getTime());
    expect(await emergency.check(token, 'password', exactAtEnd)).toBeNull();

    const afterwards = new Date(link.expiresAt.getTime() + 1000);
    expect(await emergency.check(token, 'password', afterwards)).toBeNull();
  });

  it('liefert nach dem Einlösen nichts mehr', async () => {
    const { emergency } = await buildLogin();
    const link = await emergency.generateLink('sam', 'password', 'cli:testlauf');
    const token = new URL(link.url).searchParams.get('token') as string;

    await emergency.setPassword(token, NEW_PASSWORD, SOURCE);
    expect(await emergency.check(token, 'password')).toBeNull();
  });

  it('[H1] reserviert atomar — von zwei gleichzeitigen Einlösungen trägt nur eine', async () => {
    const { emergency } = await buildLogin();
    const link = await emergency.generateLink('sam', 'passkey', 'cli:test');
    const token = new URL(link.url).searchParams.get('token') as string;

    const results = await Promise.allSettled([
      emergency.reserve(token, 'passkey'),
      emergency.reserve(token, 'passkey'),
    ]);

    const successes = results.filter((e) => e.status === 'fulfilled');
    expect(successes).toHaveLength(1);
  });

  it('[H1] gibt die Reservierung frei, wenn die nachgelagerte Prüfung scheitert', async () => {
    const { emergency } = await buildLogin();
    const link = await emergency.generateLink('sam', 'passkey', 'cli:test');
    const token = new URL(link.url).searchParams.get('token') as string;

    const reserved = await emergency.reserve(token, 'passkey');
    // Während der Reservierung ist der Link nicht mehr einlösbar …
    expect(await emergency.check(token, 'passkey')).toBeNull();

    // … nach der Rücknahme aber wieder.
    await emergency.release(reserved.registrationId);
    expect(await emergency.check(token, 'passkey')).not.toBeNull();
  });

  it('[H1] schreibt beim Freigeben KEINEN Einlöse-Eintrag ins Audit-Log', async () => {
    const { emergency, data } = await buildLogin();
    const link = await emergency.generateLink('sam', 'passkey', 'cli:test');
    const token = new URL(link.url).searchParams.get('token') as string;

    const reserved = await emergency.reserve(token, 'passkey');
    await emergency.release(reserved.registrationId);

    // „eingelöst" wäre schlicht falsch — es ist nichts eingelöst worden.
    expect(
      data.audit.some((z) => z.action === 'emergency.enrollment.redeemed'),
    ).toBe(false);
  });

  it('taugt ein Passwort-Link niemals als Passkey-Link und umgekehrt', async () => {
    const { emergency } = await buildLogin();
    const passwordLink = await emergency.generateLink('sam', 'password', 'cli:testlauf');
    const token = new URL(passwordLink.url).searchParams.get('token') as string;

    expect(await emergency.check(token, 'passkey')).toBeNull();
    expect(await emergency.check(token, 'password')).not.toBeNull();
  });
});

describe('[F10] Nur der jüngste Notfall-Link gilt', () => {
  const tokenOf = (url: string) =>
    new URL(url).searchParams.get('token') as string;

  it('entwertet beim Erzeugen eines neuen Links alle älteren des Kontos', async () => {
    const { emergency, data } = await buildLogin();
    const old = await emergency.generateLink('sam', 'passkey', 'cli:test');
    const older = await emergency.generateLink('sam', 'password', 'cli:test');
    const fresh = await emergency.generateLink('sam', 'passkey', 'cli:test');

    expect(await emergency.check(tokenOf(old.url), 'passkey')).toBeNull();
    expect(await emergency.check(tokenOf(older.url), 'password')).toBeNull();
    expect(await emergency.check(tokenOf(fresh.url), 'passkey')).not.toBeNull();
    // Markiert, nicht gelöscht.
    expect(data.emergency).toHaveLength(3);
  });

  it('entwertet beim Einlösen alle übrigen offenen Links des Kontos', async () => {
    const { emergency, data } = await buildLogin();
    const first = await emergency.generateLink('sam', 'passkey', 'cli:test');
    // Zweiten Link vorbei an der Entwertung anlegen (z. B. paralleler Aufruf).
    data.emergency.push({
      ...data.emergency[0],
      id: 'zweiter',
      tokenHash: 'anderer-hash',
      redeemedAt: null,
    });

    await emergency.resolve(tokenOf(first.url), 'passkey', {
      ip: null,
      userAgent: null,
    });

    expect(data.emergency.every((row) => row.redeemedAt !== null)).toBe(true);
  });
});
