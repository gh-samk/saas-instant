import * as argon2 from 'argon2';
import {
  LoginFailedError,
  AccountLockedError,
} from '../common/errors/business-error';
import {
  buildLogin,
  TEST_PASSWORD,
  totpCode,
} from '../test-support/login-provisioning';

// argon2 ist absichtlich langsam; Hashen und Prüfen brauchen mehr als die Vorgabe.
jest.setTimeout(30_000);

const SOURCE = { ip: '203.0.113.21', userAgent: 'Jest' };
const NEW_PASSWORD = 'ein-frisch-gesetztes-passwort';
/**
 * Bewusst eine unverwechselbare Zeichenkette: ein Wort wie „falsch" käme auch
 * in der Begründung „Aktuelles Passwort falsch." vor und der Test auf
 * Geheimnisfreiheit würde einen Fehlalarm auslösen.
 */
const WRONG_PASSWORD = 'zqx-nicht-das-richtige-geheimnis';

/** Liest den aktuell gespeicherten Passwort-Hash aus dem Doppel. */
function hashOf(data: { user: { username: string; passwordHash: string | null }[] }): string | null {
  return data.user.find((line) => line.username === 'sam')?.passwordHash ?? null;
}

describe('ZugangService.setzePasswort — Ersteinrichtung (noch kein Passwort)', () => {
  it('setzt ohne aktuellesPasswort, wenn noch keines hinterlegt ist', async () => {
    const { access, sessionUser, data, service } = await buildLogin();
    data.user[0].passwordHash = null;

    await access.setPassword(
      sessionUser,
      NEW_PASSWORD,
      undefined,
      SOURCE,
      new Date(),
    );

    const hash = hashOf(data);
    expect(hash).not.toBeNull();
    expect(await argon2.verify(hash as string, NEW_PASSWORD)).toBe(true);

    // Das neue Passwort ist Faktor EINS — der zweite Faktor bleibt Pflicht.
    const step1 = await service.passwordLogin(
      'sam',
      NEW_PASSWORD,
      undefined,
      SOURCE,
    );
    expect(step1.kind).toBe('second-factor');
  });

  it('vermerkt im Audit-Log, dass vorher keines gesetzt war', async () => {
    const { access, sessionUser, data } = await buildLogin();
    data.user[0].passwordHash = null;

    await access.setPassword(sessionUser, NEW_PASSWORD, undefined, SOURCE, new Date());

    const entry = data.audit.find((z) => z.action === 'password.set');
    expect(entry?.beforeValue).toEqual({
      updated: false,
      wasAlreadySet: false,
    });
    expect(entry?.afterValue).toEqual({
      updated: true,
      viaEmergencyLink: false,
      invalidatedTrustedDevices: 0,
    });
    expect(entry?.ip).toBe('203.0.113.21');
  });
});

describe('ZugangService.setzePasswort — Änderung (Passwort bereits gesetzt)', () => {
  it('verlangt das aktuelle Passwort und nimmt das richtige an', async () => {
    const { access, sessionUser, data } = await buildLogin();

    await expect(
      access.setPassword(sessionUser, NEW_PASSWORD, undefined, SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);
    // Ohne gültigen Nachweis bleibt das alte Passwort stehen.
    expect(await argon2.verify(hashOf(data) as string, TEST_PASSWORD)).toBe(true);

    await access.setPassword(
      sessionUser,
      NEW_PASSWORD,
      TEST_PASSWORD,
      SOURCE,
    );
    expect(await argon2.verify(hashOf(data) as string, NEW_PASSWORD)).toBe(true);
  });

  it('weist ein leeres aktuellesPasswort ab', async () => {
    const { access, sessionUser } = await buildLogin();

    await expect(
      access.setPassword(sessionUser, NEW_PASSWORD, '', SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);
  });

  it('zählt ein falsches aktuellesPasswort auf denselben Sperrzähler', async () => {
    const { access, sessionUser, data } = await buildLogin();

    await expect(
      access.setPassword(sessionUser, NEW_PASSWORD, WRONG_PASSWORD, SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);

    expect(data.user[0].failedAttempts).toBe(1);
    expect(
      data.audit.some((z) => z.action === 'password.change.failure'),
    ).toBe(true);
  });

  it('sperrt nach fünf falschen Versuchen mit dem bekannten Vertrag', async () => {
    const { access, sessionUser, data } = await buildLogin();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(
        access.setPassword(sessionUser, NEW_PASSWORD, WRONG_PASSWORD, SOURCE),
      ).rejects.toBeInstanceOf(LoginFailedError);
    }

    let caught: unknown = null;
    try {
      await access.setPassword(sessionUser, NEW_PASSWORD, WRONG_PASSWORD, SOURCE);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AccountLockedError);
    const error = caught as AccountLockedError;
    expect(error.errorCode).toBe('account_locked');
    expect(error.errorDetail).toEqual({ secondsRemaining: 900 });

    // Auch mit dem RICHTIGEN aktuellen Passwort geht jetzt nichts mehr.
    await expect(
      access.setPassword(sessionUser, NEW_PASSWORD, TEST_PASSWORD, SOURCE),
    ).rejects.toMatchObject({ errorCode: 'account_locked' });
  });

  it('setzt bei Erfolg Fehlversuche und Sperre zurück', async () => {
    const { access, sessionUser, data } = await buildLogin();

    await expect(
      access.setPassword(sessionUser, NEW_PASSWORD, WRONG_PASSWORD, SOURCE),
    ).rejects.toBeDefined();
    expect(data.user[0].failedAttempts).toBe(1);

    await access.setPassword(
      sessionUser,
      NEW_PASSWORD,
      TEST_PASSWORD,
      SOURCE,
    );
    expect(data.user[0].failedAttempts).toBe(0);
    expect(data.user[0].lockedUntil).toBeNull();
  });
});

describe('ZugangService.setzePasswort — Merk-Geräte und Geheimnisse', () => {
  it('entwertet alle Merk-Geräte', async () => {
    const { access, sessionUser, service, data, secret } =
      await buildLogin();

    // Erst regulär anmelden und den Browser merken lassen.
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
    expect(data.devices).toHaveLength(1);

    await access.setPassword(
      sessionUser,
      NEW_PASSWORD,
      TEST_PASSWORD,
      SOURCE,
    );

    expect(data.devices).toHaveLength(0);
    const entry = data.audit.find((z) => z.action === 'password.set');
    expect(entry?.afterValue).toMatchObject({ invalidatedTrustedDevices: 1 });

    // Der alte Merk-Token trägt nicht mehr: zweiter Faktor wieder fällig.
    const afterwards = await service.passwordLogin(
      'sam',
      NEW_PASSWORD,
      done.trustedToken,
      SOURCE,
    );
    expect(afterwards.kind).toBe('second-factor');
  });

  it('schreibt weder Klartext noch Hash ins Audit-Log — alt wie neu', async () => {
    const { access, sessionUser, data } = await buildLogin();
    const oldHash = hashOf(data) as string;

    // Ein Fehlversuch und eine erfolgreiche Änderung.
    await expect(
      access.setPassword(sessionUser, NEW_PASSWORD, WRONG_PASSWORD, SOURCE),
    ).rejects.toBeDefined();
    await access.setPassword(
      sessionUser,
      NEW_PASSWORD,
      TEST_PASSWORD,
      SOURCE,
    );

    const everything = JSON.stringify(data.audit);
    expect(everything).not.toContain(TEST_PASSWORD);
    expect(everything).not.toContain(NEW_PASSWORD);
    expect(everything).not.toContain(WRONG_PASSWORD);
    expect(everything).not.toContain(oldHash);
    expect(everything).not.toContain(hashOf(data));
    expect(everything).not.toContain('$argon2');
  });
});

describe('ZugangService.setzePasswort — Erstvergabe nur aus frischer Anmeldung ([H2])', () => {
  /**
   * Prüfung vom 13.09.2026: Ein Konto ohne Passwort (frisch aus `first-account`
   * oder `emergency enrollment`) nahm ein neues Passwort aus JEDER gültigen
   * Sitzung an. Mit einem erbeuteten, tagealten Cookie liess sich so ein
   * eigenes Passwort setzen und ein frischer Nachweiszeitpunkt erschleichen.
   */
  const NOW = new Date('2026-09-14T08:00:00Z');
  const beforeMinutes = (minutes: number): Date =>
    new Date(NOW.getTime() - minutes * 60_000);

  async function withoutPassword() {
    const provisioning = await buildLogin();
    provisioning.data.user[0].passwordHash = null;
    return provisioning;
  }

  it('lehnt ab, wenn die Anmeldung länger als zehn Minuten zurückliegt', async () => {
    const { access, sessionUser, data } = await withoutPassword();

    await expect(
      access.setPassword(
        sessionUser,
        NEW_PASSWORD,
        undefined,
        SOURCE,
        beforeMinutes(25 * 60),
        NOW,
      ),
    ).rejects.toMatchObject({ errorCode: 'login_too_old' });

    expect(hashOf(data)).toBeNull();
    const entry = data.audit.find((z) => z.action === 'password.change.failure');
    expect(entry?.ip).toBe('203.0.113.21');
  });

  it('lehnt ab, wenn das Token keinen Nachweiszeitpunkt trägt', async () => {
    const { access, sessionUser, data } = await withoutPassword();

    await expect(
      access.setPassword(sessionUser, NEW_PASSWORD, undefined, SOURCE, null, NOW),
    ).rejects.toMatchObject({ errorCode: 'login_too_old' });
    expect(hashOf(data)).toBeNull();
  });

  it('lehnt ab, wenn kein Nachweiszeitpunkt übergeben wird (sichere Vorgabe)', async () => {
    const { access, sessionUser, data } = await withoutPassword();

    await expect(
      access.setPassword(sessionUser, NEW_PASSWORD, undefined, SOURCE),
    ).rejects.toMatchObject({ errorCode: 'login_too_old' });
    expect(hashOf(data)).toBeNull();
  });

  it('lehnt einen Nachweiszeitpunkt in der Zukunft ab', async () => {
    const { access, sessionUser, data } = await withoutPassword();

    await expect(
      access.setPassword(
        sessionUser,
        NEW_PASSWORD,
        undefined,
        SOURCE,
        beforeMinutes(-1),
        NOW,
      ),
    ).rejects.toMatchObject({ errorCode: 'login_too_old' });
    expect(hashOf(data)).toBeNull();
  });

  it('nimmt eine Anmeldung von vor neun Minuten an', async () => {
    const { access, sessionUser, data } = await withoutPassword();

    await access.setPassword(
      sessionUser,
      NEW_PASSWORD,
      undefined,
      SOURCE,
      beforeMinutes(9),
      NOW,
    );

    expect(await argon2.verify(hashOf(data) as string, NEW_PASSWORD)).toBe(true);
  });

  it('verlangt bei gesetztem Passwort weiterhin das Passwort — auch in frischer Sitzung', async () => {
    const { access, sessionUser, data } = await buildLogin();

    await expect(
      access.setPassword(
        sessionUser,
        NEW_PASSWORD,
        undefined,
        SOURCE,
        beforeMinutes(1),
        NOW,
      ),
    ).rejects.toBeInstanceOf(LoginFailedError);
    expect(await argon2.verify(hashOf(data) as string, TEST_PASSWORD)).toBe(true);
  });
});
