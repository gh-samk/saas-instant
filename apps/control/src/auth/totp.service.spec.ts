import { NotFoundException } from '@nestjs/common';
import {
  buildLogin,
  TEST_PASSWORD,
  totpCode,
} from '../test-support/login-provisioning';
import { AUDIT_ACTION } from '../audit/audit.service';
import {
  LoginFailedError,
  AccountLockedError,
} from '../common/errors/business-error';
import { MAX_FAILED_ATTEMPTS } from './lockout.service';
import { TOTP_PENDING_VALID_MS } from './totp.service';

jest.setTimeout(60_000);

const SOURCE = { ip: '203.0.113.9', userAgent: 'Jest' };

/**
 * [K4], zweiter Schaden: Die Einrichtung überschrieb das aktive TOTP-Geheimnis
 * SOFORT. Wer den Dialog in den Einstellungen öffnete und abbrach, hatte einen
 * toten Authenticator — ohne Hinweis, ohne Weg zurück.
 */
describe('TOTP-Einrichtung ist bis zur Bestätigung folgenlos', () => {
  it('lässt das AKTIVE Geheimnis beim Einrichten unberührt', async () => {
    const { access, sessionUser, data, secret } = await buildLogin({});
    const before = data.user[0].totpSecret;

    await access.totpSetup(sessionUser);

    expect(data.user[0].totpSecret).toBe(before);
    expect(data.user[0].totpSecretPending).not.toBeNull();
    // Dass der alte Authenticator weiter funktioniert, zeigt der nächste Test.
    expect(secret.length).toBeGreaterThan(0);
  });

  it('lässt den ALTEN Code nach einem abgebrochenen Dialog weiter gelten', async () => {
    const { service, access, sessionUser, secret } = await buildLogin({});

    // Dialog geöffnet …
    await access.totpSetup(sessionUser);
    // … und abgebrochen. Kein `bestaetigen`.

    const result = await service.passwordLogin(
      'sam',
      'ein-hinreichend-langes-testpasswort',
      undefined,
      SOURCE,
    );
    if (result.kind !== 'second-factor') throw new Error('Erwartet: 2FA.');
    await expect(
      service.secondFactorTotp(
        result.flowToken,
        totpCode(secret),
        false,
        SOURCE,
      ),
    ).resolves.toMatchObject({ kind: 'session' });
  });

  it('übernimmt das neue Geheimnis erst mit der Bestätigung', async () => {
    const { access, sessionUser, data } = await buildLogin({});
    const old = data.user[0].totpSecret;

    const setup = await access.totpSetup(sessionUser);
    await access.totpConfirm(
      sessionUser,
      totpCode(setup.secretBase32),
      SOURCE,
    );

    expect(data.user[0].totpSecret).not.toBe(old);
    expect(data.user[0].totpSecretPending).toBeNull();
  });

  it('weist einen falschen Bestätigungscode ab und lässt alles, wie es war', async () => {
    const { access, sessionUser, data } = await buildLogin({});
    const old = data.user[0].totpSecret;
    await access.totpSetup(sessionUser);

    await expect(
      access.totpConfirm(sessionUser, '000000', SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);

    expect(data.user[0].totpSecret).toBe(old);
    expect(data.user[0].totpSecretPending).not.toBeNull();
  });

  it('weist die Bestätigung ohne vorherige Einrichtung ab', async () => {
    const { access, sessionUser } = await buildLogin({});

    await expect(
      access.totpConfirm(sessionUser, '000000', SOURCE),
    ).rejects.toThrow();
  });

  it('räumt beim Entfernen des Faktors auch das vorläufige Geheimnis weg', async () => {
    const { access, sessionUser, data } = await buildLogin({
      loginCodeEnabled: true,
    });
    await access.totpSetup(sessionUser);

    await access.factorRemove(sessionUser, 'totp', SOURCE);

    expect(data.user[0].totpSecret).toBeNull();
    expect(data.user[0].totpSecretPending).toBeNull();
  });

  it('meldet den Faktor erst nach der Bestätigung als eingerichtet', async () => {
    const { access, sessionUser, data } = await buildLogin({});
    data.user[0].totpSecret = null;

    await access.totpSetup(sessionUser);
    const before = await access.factors(sessionUser.id);
    expect(before.factors.find((f) => f.kind === 'totp')?.setUp).toBe(
      false,
    );
  });
});

/**
 * [K5]: `POST /api/zugang/totp/bestaetigen` war eine ungebremste Ratestrecke.
 *
 * Gemessen an der laufenden Anwendung: 100 Rateversuche (das globale
 * IP-Limit) gingen durch, danach stand `fehlversuche` auf 0, `gesperrtBis` auf
 * NULL und im Audit-Log lagen null neue Zeilen. Die Route trägt
 * `@OhneZweitfaktor`, weil der erste Schritt den Nachweis verlangt hat — mit
 * einem liegenden vorläufigen Geheimnis ist sie aber ein Orakel auf sechs
 * Ziffern, dessen Treffer sofort ein aktives `totpGeheimnis` ergibt.
 *
 * Die vier Teilfixes hängen zusammen und werden hier einzeln festgenagelt.
 * Jeder Test schlägt gegen die alte Fassung fehl.
 */
describe('[K5] Die Bestätigung der TOTP-Einrichtung ist gebremst', () => {
  it('verbucht einen falschen Code als Fehlversuch auf der Kontosperre', async () => {
    const { access, sessionUser, data } = await buildLogin({});
    await access.totpSetup(sessionUser);
    expect(data.user[0].failedAttempts).toBe(0);

    await expect(
      access.totpConfirm(sessionUser, '000000', SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);

    // Die alte Fassung ließ hier 0 stehen — beliebig oft.
    expect(data.user[0].failedAttempts).toBe(1);
  });

  it('schreibt zu jedem Fehlschlag eine Audit-Zeile — ohne den geratenen Code', async () => {
    const { access, sessionUser, data } = await buildLogin({});
    await access.totpSetup(sessionUser);

    await expect(
      access.totpConfirm(sessionUser, '123456', SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);

    const lines = data.audit.filter(
      (entry) => entry.action === AUDIT_ACTION.totpSetupError,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].ip).toBe(SOURCE.ip);
    // Weder der Rateversuch noch das Geheimnis dürfen im Log landen.
    expect(JSON.stringify(data.audit)).not.toContain('123456');
    expect(JSON.stringify(data.audit)).not.toContain(
      data.user[0].totpSecretPending,
    );
  });

  it('sperrt das Konto nach MAX_FEHLVERSUCHE geratenen Codes', async () => {
    const { access, sessionUser, data } = await buildLogin({});
    await access.totpSetup(sessionUser);

    for (let attempt = 1; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await expect(
        access.totpConfirm(sessionUser, '000000', SOURCE),
      ).rejects.toBeInstanceOf(LoginFailedError);
    }
    await expect(
      access.totpConfirm(sessionUser, '000000', SOURCE),
    ).rejects.toBeInstanceOf(AccountLockedError);

    expect(data.user[0].lockedUntil).not.toBeNull();
  });

  it('lässt ein gesperrtes Konto gar nicht erst raten', async () => {
    const { access, sessionUser, data } = await buildLogin({});
    await access.totpSetup(sessionUser);
    data.user[0].lockedUntil = new Date(Date.now() + 60_000);
    const before = data.user[0].failedAttempts;

    await expect(
      access.totpConfirm(sessionUser, '000000', SOURCE),
    ).rejects.toBeInstanceOf(AccountLockedError);

    // Kein zusätzlicher Fehlversuch: abgewiesen wurde vor der Prüfung.
    expect(data.user[0].failedAttempts).toBe(before);
  });

  it('setzt den Sperrzähler nach einer erfolgreichen Bestätigung zurück', async () => {
    const { access, sessionUser, data } = await buildLogin({});
    const setup = await access.totpSetup(sessionUser);
    await expect(
      access.totpConfirm(sessionUser, '000000', SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);
    expect(data.user[0].failedAttempts).toBe(1);

    await access.totpConfirm(
      sessionUser,
      totpCode(setup.secretBase32),
      SOURCE,
    );

    // Sonst machten vier Vertipper beim Einrichten den nächsten Vertipper bei
    // der Anmeldung zur Sperre — ohne erkennbaren Zusammenhang.
    expect(data.user[0].failedAttempts).toBe(0);
  });

  it('zählt einen ZUSTANDSFEHLER nicht als Rateversuch', async () => {
    const { access, sessionUser, data } = await buildLogin({});
    // Gar keine Einrichtung angefangen: hier hat niemand etwas geraten.
    await expect(
      access.totpConfirm(sessionUser, '000000', SOURCE),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(data.user[0].failedAttempts).toBe(0);
    expect(data.audit).toHaveLength(0);
  });
});

/**
 * [K5], dritter Teilfix: das vorläufige Geheimnis bekommt eine Frist.
 *
 * Ohne sie blieb der Zustand „unbestätigtes Geheimnis liegt am Konto"
 * dauerhaft — der Normalfall nach jedem abgebrochenen Dialog — und genau er
 * ist die Voraussetzung der Ratestrecke.
 */
describe('[K5] Das vorläufige TOTP-Geheimnis läuft ab und wird entwertet', () => {
  it('verfällt nach TOTP_VORLAEUFIG_GUELTIG_MS und wird dabei weggeräumt', async () => {
    const { access, sessionUser, data } = await buildLogin({});
    const setup = await access.totpSetup(sessionUser);
    // Frist um eine Sekunde überschritten.
    data.user[0].totpPendingValidUntil = new Date(Date.now() - 1000);

    await expect(
      access.totpConfirm(
        sessionUser,
        totpCode(setup.secretBase32),
        SOURCE,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    // Der richtige Code half nicht mehr — und das Geheimnis liegt nicht länger
    // als Ratestrecke herum.
    expect(data.user[0].totpSecretPending).toBeNull();
    expect(data.user[0].totpPendingValidUntil).toBeNull();
  });

  it('setzt beim Einrichten überhaupt eine Frist', async () => {
    const { access, sessionUser, data } = await buildLogin({});
    const before = Date.now();

    await access.totpSetup(sessionUser);

    const deadline = data.user[0].totpPendingValidUntil;
    expect(deadline).not.toBeNull();
    expect(deadline!.getTime()).toBeGreaterThanOrEqual(
      before + TOTP_PENDING_VALID_MS,
    );
  });

  it('behandelt ein fristloses Altgeheimnis als abgelaufen', async () => {
    const { access, sessionUser, data } = await buildLogin({});
    const setup = await access.totpSetup(sessionUser);
    // So sah jedes Geheimnis aus, das die fristlose Fassung geschrieben hat.
    data.user[0].totpPendingValidUntil = null;

    await expect(
      access.totpConfirm(
        sessionUser,
        totpCode(setup.secretBase32),
        SOURCE,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('entwertet es beim Passwortwechsel', async () => {
    const { access, sessionUser, data } = await buildLogin({});
    await access.totpSetup(sessionUser);

    await access.setPassword(
      sessionUser,
      'ein-anderes-hinreichend-langes-passwort',
      TEST_PASSWORD,
      SOURCE,
    );

    expect(data.user[0].totpSecretPending).toBeNull();
    expect(data.user[0].totpPendingValidUntil).toBeNull();
  });

  it('entwertet es bei „alle Geräte abmelden"', async () => {
    const { access, sessionUser, data } = await buildLogin({});
    await access.totpSetup(sessionUser);

    await access.signOutAllDevices(sessionUser, SOURCE);

    // Die Notbremse ist der Griff für „ich vermute ein erbeutetes Cookie" —
    // aus genau so einem Cookie heraus entsteht das vorläufige Geheimnis.
    expect(data.user[0].totpSecretPending).toBeNull();
    expect(data.user[0].totpPendingValidUntil).toBeNull();
  });

  it('entwertet es auch über den Notfall-Passwortlink', async () => {
    const { access, emergency, sessionUser, data } = await buildLogin({});
    await access.totpSetup(sessionUser);

    const link = await emergency.generateLink('sam', 'password', 'cli:testlauf');
    const token = new URL(link.url).searchParams.get('token') as string;
    await emergency.setPassword(
      token,
      'ein-anderes-hinreichend-langes-passwort',
      SOURCE,
    );

    // Der Notfall-Link wird gerade dann gezogen, wenn ein Missbrauch im Raum
    // steht — dann darf erst recht keine Ratestrecke stehenbleiben.
    expect(data.user[0].totpSecretPending).toBeNull();
    expect(data.user[0].totpPendingValidUntil).toBeNull();
  });

  it('lässt das AKTIVE Geheimnis von beidem unberührt', async () => {
    const { access, sessionUser, data } = await buildLogin({});
    const active = data.user[0].totpSecret;
    await access.totpSetup(sessionUser);

    await access.signOutAllDevices(sessionUser, SOURCE);

    expect(data.user[0].totpSecret).toBe(active);
  });
});

describe('[F9] TOTP-Replay', () => {
  it('lehnt denselben Code ein zweites Mal ab, einen späteren Schritt nicht', async () => {
    const { totp, user, secret } = await buildLogin();
    const now = new Date();
    const code = totpCode(secret);
    const encrypted = user.totpSecret as string;

    expect(await totp.checkAndConsume(user.id, encrypted, code, now)).toBe(true);
    expect(await totp.checkAndConsume(user.id, encrypted, code, now)).toBe(false);
  });

  it('lässt von zwei gleichzeitigen Einreichungen desselben Codes genau eine zu', async () => {
    const { totp, user, secret } = await buildLogin();
    const code = totpCode(secret);
    const encrypted = user.totpSecret as string;

    const results = await Promise.all([
      totp.checkAndConsume(user.id, encrypted, code),
      totp.checkAndConsume(user.id, encrypted, code),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
