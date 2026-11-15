import { LoginFailedError } from '../common/errors/business-error';
import {
  buildLogin,
  TEST_PASSWORD,
  totpCode,
} from '../test-support/login-provisioning';

// argon2 ist absichtlich langsam; Hashen und Prüfen brauchen mehr als die Vorgabe.
jest.setTimeout(30_000);

const SOURCE = { ip: '203.0.113.9', userAgent: 'Jest' };

describe('AnmeldungService — Faktor eins: Benutzername oder E-Mail plus Passwort', () => {
  it('nimmt das richtige Passwort an und verlangt danach den zweiten Faktor', async () => {
    const { service } = await buildLogin();

    const result = await service.passwordLogin(
      'sam',
      TEST_PASSWORD,
      undefined,
      SOURCE,
    );

    expect(result.kind).toBe('second-factor');
  });

  it('nimmt statt des Benutzernamens auch die E-Mail-Adresse an', async () => {
    const { service } = await buildLogin();

    const result = await service.passwordLogin(
      'INHABER@example.com',
      TEST_PASSWORD,
      undefined,
      SOURCE,
    );

    expect(result.kind).toBe('second-factor');
  });

  it('weist ein falsches Passwort ab und zählt es als Fehlversuch', async () => {
    const { service, data } = await buildLogin();

    await expect(
      service.passwordLogin('sam', 'wrong', undefined, SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);

    expect(data.user[0].failedAttempts).toBe(1);
    expect(
      data.audit.some((z) => z.action === 'login.password.failure'),
    ).toBe(true);
  });

  it('weist eine unbekannte Kennung mit derselben Meldung ab', async () => {
    const { service, data } = await buildLogin();

    await expect(
      service.passwordLogin('gibtsnicht', TEST_PASSWORD, undefined, SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);

    // Kein Konto getroffen: der Fehlversuch darf keinem fremden Konto angelastet werden.
    expect(data.user[0].failedAttempts).toBe(0);
    const entry = data.audit.find(
      (z) => z.action === 'login.password.failure',
    );
    // Die Kennung wird gekürzt protokolliert (H5): wer sein Passwort ins
    // Benutzernamenfeld tippt, soll es nicht im Klartext im Nachweis finden.
    expect(entry?.actor).toBe('gib…(10 Zeichen)');
    expect(entry?.afterValue).toMatchObject({ accountKnown: false });
  });

  it('meldet ein Konto ohne hinterlegtes Passwort nicht an', async () => {
    const { service, data } = await buildLogin();
    data.user[0].passwordHash = null;

    await expect(
      service.passwordLogin('sam', TEST_PASSWORD, undefined, SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);
  });

  it('sperrt nach fünf falschen Passwörtern und meldet Restsekunden', async () => {
    const { service, data } = await buildLogin();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(
        service.passwordLogin('sam', 'wrong', undefined, SOURCE),
      ).rejects.toBeInstanceOf(LoginFailedError);
    }

    let caught: unknown = null;
    try {
      await service.passwordLogin('sam', 'wrong', undefined, SOURCE);
    } catch (error) {
      caught = error;
    }
    const error = caught as { errorCode?: string; errorDetail?: unknown };
    expect(error.errorCode).toBe('account_locked');
    expect(error.errorDetail).toEqual({ secondsRemaining: 900 });

    // Auch mit dem RICHTIGEN Passwort geht jetzt nichts mehr.
    await expect(
      service.passwordLogin('sam', TEST_PASSWORD, undefined, SOURCE),
    ).rejects.toMatchObject({ errorCode: 'account_locked' });
    expect(data.user[0].lockedUntil).not.toBeNull();
  });
});

describe('AnmeldungService — Faktor zwei: TOTP oder Wiederherstellungscode', () => {
  it('Passwort allein reicht nicht: erst der TOTP-Code erzeugt die Sitzung', async () => {
    const { service, secret } = await buildLogin();

    const step1 = await service.passwordLogin(
      'sam',
      TEST_PASSWORD,
      undefined,
      SOURCE,
    );
    if (step1.kind !== 'second-factor') throw new Error('unerwartet');

    const step2 = await service.secondFactorTotp(
      step1.flowToken,
      totpCode(secret),
      false,
      SOURCE,
    );
    expect(step2.kind).toBe('session');
    expect(step2.user.username).toBe('sam');
    // Ohne ausdrücklichen Wunsch entsteht kein Merk-Gerät.
    expect(step2.trustedToken).toBeUndefined();
  });

  it('weist einen falschen TOTP-Code ab und zählt ihn als Fehlversuch', async () => {
    const { service, data } = await buildLogin();

    const step1 = await service.passwordLogin(
      'sam',
      TEST_PASSWORD,
      undefined,
      SOURCE,
    );
    if (step1.kind !== 'second-factor') throw new Error('unerwartet');

    await expect(
      service.secondFactorTotp(step1.flowToken, '000000', false, SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);
    expect(data.user[0].failedAttempts).toBe(1);
  });

  it('lässt den zweiten Schritt ohne begonnenen Vorgang nicht zu', async () => {
    const { service, secret } = await buildLogin();

    await expect(
      service.secondFactorTotp(undefined, totpCode(secret), false, SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);
  });

  it('ersetzt TOTP durch einen Wiederherstellungscode, der danach verbraucht ist', async () => {
    const { service, codes, user, data } = await buildLogin();
    const eight = await codes.generateNewCodes(user.id);

    const step1 = await service.passwordLogin(
      'sam',
      TEST_PASSWORD,
      undefined,
      SOURCE,
    );
    if (step1.kind !== 'second-factor') throw new Error('unerwartet');

    const done = await service.secondFactorRecoveryCode(
      step1.flowToken,
      eight[0],
      SOURCE,
    );
    expect(done.kind).toBe('session');
    // Der Ersatzweg legt bewusst KEIN Merk-Gerät an.
    expect(done.trustedToken).toBeUndefined();
    expect(data.devices).toHaveLength(0);
    expect(await codes.countOpen(user.id)).toBe(7);

    // Derselbe Code ein zweites Mal: abgewiesen.
    const again = await service.passwordLogin(
      'sam',
      TEST_PASSWORD,
      undefined,
      SOURCE,
    );
    if (again.kind !== 'second-factor') throw new Error('unerwartet');
    await expect(
      service.secondFactorRecoveryCode(
        again.flowToken,
        eight[0],
        SOURCE,
      ),
    ).rejects.toBeInstanceOf(LoginFailedError);
    expect(await codes.countOpen(user.id)).toBe(7);
  });
});

describe('AnmeldungService — Merk-Gerät überspringt nur den zweiten Faktor', () => {
  /** Meldet vollständig an und lässt dabei den Browser merken. */
  async function loginAndRemember(
    service: Awaited<ReturnType<typeof buildLogin>>['service'],
    secret: string,
  ): Promise<string> {
    const step1 = await service.passwordLogin(
      'sam',
      TEST_PASSWORD,
      undefined,
      SOURCE,
    );
    if (step1.kind !== 'second-factor') throw new Error('unerwartet');
    const done = await service.secondFactorTotp(
      step1.flowToken,
      totpCode(secret),
      true,
      SOURCE,
    );
    if (!done.trustedToken) throw new Error('Merk-Token fehlt');
    return done.trustedToken;
  }

  it('legt bei geraetMerken ein Merk-Gerät für 30 Tage an', async () => {
    const { service, secret, data } = await buildLogin();
    const token = await loginAndRemember(service, secret);

    expect(token).toHaveLength(43);
    expect(data.devices).toHaveLength(1);
    expect(data.devices[0].label.startsWith('Merk-Gerät · ')).toBe(true);
    const days = Math.round(
      (data.devices[0].validUntil.getTime() - Date.now()) / 86_400_000,
    );
    expect(days).toBe(30);
  });

  it('überspringt mit gültigem Merk-Gerät den zweiten Faktor', async () => {
    const { service, secret } = await buildLogin();
    const token = await loginAndRemember(service, secret);

    const result = await service.passwordLogin(
      'sam',
      TEST_PASSWORD,
      token,
      SOURCE,
    );
    expect(result.kind).toBe('session');
    if (result.kind !== 'session') throw new Error('unerwartet');
    // Rotation: es kommt ein NEUER Token zurück.
    expect(result.trustedToken).toBeDefined();
    expect(result.trustedToken).not.toBe(token);
  });

  it('ersetzt NIEMALS das Passwort — mit falschem Passwort scheitert es trotz Merk-Gerät', async () => {
    const { service, secret, data } = await buildLogin();
    const token = await loginAndRemember(service, secret);

    await expect(
      service.passwordLogin('sam', 'wrong', token, SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);

    expect(data.user[0].failedAttempts).toBe(1);
    // Das Gerät bleibt bestehen, es wurde aber nicht als Zugang gewertet.
    expect(data.devices).toHaveLength(1);
  });

  it('ist ohne Passwort wertlos — ein Merk-Keks allein ist kein Zugang', async () => {
    const { service, secret } = await buildLogin();
    const token = await loginAndRemember(service, secret);

    await expect(
      service.passwordLogin('sam', '', token, SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);
  });

  it('entwertet den alten Merk-Token bei jeder Nutzung (Rotation)', async () => {
    const { service, secret } = await buildLogin();
    const old = await loginAndRemember(service, secret);

    const first = await service.passwordLogin(
      'sam',
      TEST_PASSWORD,
      old,
      SOURCE,
    );
    if (first.kind !== 'session') throw new Error('unerwartet');

    // Mit dem ALTEN Token ist der zweite Faktor wieder fällig.
    const second = await service.passwordLogin(
      'sam',
      TEST_PASSWORD,
      old,
      SOURCE,
    );
    expect(second.kind).toBe('second-factor');

    // Mit dem neuen Token dagegen nicht.
    const third = await service.passwordLogin(
      'sam',
      TEST_PASSWORD,
      first.trustedToken,
      SOURCE,
    );
    expect(third.kind).toBe('session');
  });

  it('erkennt ein Merk-Gerät eines anderen Kontos nicht an', async () => {
    const { service, devices } = await buildLogin();
    const { token } = await devices.remember(
      'ein-fremdes-konto',
      'Merk-Gerät · fremd',
    );

    const result = await service.passwordLogin(
      'sam',
      TEST_PASSWORD,
      token,
      SOURCE,
    );
    expect(result.kind).toBe('second-factor');
  });

  it('wirkt nach Widerruf des Geräts nicht mehr', async () => {
    const { service, secret, devices, user } = await buildLogin();
    const token = await loginAndRemember(service, secret);

    await devices.revokeAll(user.id);

    const result = await service.passwordLogin(
      'sam',
      TEST_PASSWORD,
      token,
      SOURCE,
    );
    expect(result.kind).toBe('second-factor');
  });
});

describe('[F8] Abmelden beendet die Sitzung serverseitig', () => {
  it('zählt die Sitzungs-Generation hoch, damit das alte Token wertlos ist', async () => {
    const { service, sessionUser, data } = await buildLogin();
    const before = data.user[0].sessionGeneration;

    await service.logout(sessionUser, { ip: null, userAgent: null });

    expect(data.user[0].sessionGeneration).toBe(before + 1);
  });
});
