import * as argon2 from 'argon2';
import { LoginFailedError } from '../common/errors/business-error';
import {
  buildLogin,
  TEST_PASSWORD,
  totpCode,
} from '../test-support/login-provisioning';
import { maskIdentifier } from './login.service';
import { MAX_FAILED_ATTEMPTS } from './lockout.service';

jest.setTimeout(30_000);

const SOURCE = { ip: '203.0.113.31', userAgent: 'Jest' };

/** Sperrt das Konto über den Passwortpfad. */
async function lockoutAccount(
  service: Awaited<ReturnType<typeof buildLogin>>['service'],
): Promise<void> {
  for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
    await service
      .passwordLogin('sam', 'zqx-nicht-das-passwort', undefined, SOURCE)
      .catch(() => undefined);
  }
}

describe('[W7] Die Kontosperre gilt nur für den Passwortpfad', () => {
  it('sperrt den Passwortweg nach fünf Fehlversuchen', async () => {
    const { service, data } = await buildLogin();
    await lockoutAccount(service);

    expect(data.user[0].lockedUntil).not.toBeNull();
    await expect(
      service.passwordLogin('sam', TEST_PASSWORD, undefined, SOURCE),
    ).rejects.toMatchObject({ errorCode: 'account_locked' });
  });

  it('lässt den Passkey-Start bei gesperrtem Konto unverändert antworten', async () => {
    const { service, data } = await buildLogin();
    const before = await service.passkeyStart();

    await lockoutAccount(service);
    expect(data.user[0].lockedUntil).not.toBeNull();

    // Kein konto_gesperrt, keine abweichende Antwortform: die Route ist
    // unauthentifiziert und darf den Kontozustand nicht verraten.
    const after = await service.passkeyStart();
    expect(Object.keys(after.options).sort()).toEqual(
      Object.keys(before.options).sort(),
    );
  });

  it('[W1] gibt NIE allowCredentials heraus — auch nicht für ein Konto mit Passkeys', async () => {
    const { service, data, user } = await buildLogin();

    // Konto mit zwei hinterlegten Passkeys: vorher hätte die Antwort eine
    // zweielementige allowCredentials-Liste enthalten und damit verraten,
    // dass die Kennung existiert.
    data.passkeys.push(
      {
        id: 'p1',
        userId: user.id,
        credentialId: 'cred-1',
        publicKey: 'AAAA',
        counter: 0,
        transports: null,
        label: 'Passkey · Test 1',
        createdAt: new Date(),
        lastUsedAt: null,
      },
      {
        id: 'p2',
        userId: user.id,
        credentialId: 'cred-2',
        publicKey: 'BBBB',
        counter: 0,
        transports: null,
        label: 'Passkey · Test 2',
        createdAt: new Date(),
        lastUsedAt: null,
      },
    );

    const withPasskeys = await service.passkeyStart();
    expect(withPasskeys.options.allowCredentials).toEqual([]);

    // Und ohne jeden Passkey sieht die Antwort exakt genauso aus.
    data.passkeys.length = 0;
    const withoutPasskeys = await service.passkeyStart();
    expect(withoutPasskeys.options.allowCredentials).toEqual([]);
    expect(Object.keys(withPasskeys.options).sort()).toEqual(
      Object.keys(withoutPasskeys.options).sort(),
    );
  });

  it('[W1] bindet den Vorgang an kein Konto — das steht erst beim Abschluss fest', async () => {
    const { service } = await buildLogin();
    const { flowToken } = await service.passkeyStart();

    const payload = JSON.parse(
      Buffer.from(flowToken.split('.')[1], 'base64url').toString('utf8'),
    ) as { userId: string | null };
    expect(payload.userId).toBeNull();
  });

  it('zählt einen fehlgeschlagenen Passkey NICHT auf die Sperre', async () => {
    const { service, data } = await buildLogin();
    const { flowToken } = await service.passkeyStart();

    // Unbekannte Credential-ID: der Passkey-Weg scheitert …
    await expect(
      service.passkeyComplete(
        flowToken,
        {
          id: 'unbekannte-credential-id',
          rawId: 'unbekannte-credential-id',
          type: 'public-key',
          response: {},
          clientExtensionResults: {},
        } as never,
        SOURCE,
      ),
    ).rejects.toBeInstanceOf(LoginFailedError);

    // … aber der Sperrzähler bleibt unberührt.
    expect(data.user[0].failedAttempts).toBe(0);
    expect(data.user[0].lockedUntil).toBeNull();
    expect(
      data.audit.some((z) => z.action === 'login.passkey.failure'),
    ).toBe(true);
  });
});

describe('[W5] Kontoaufzählung über die Antwortzeit', () => {
  it('verifiziert auch bei unbekannter Kennung gegen einen Hash', async () => {
    const { service } = await buildLogin();

    const measure = async (identifier: string): Promise<number> => {
      const start = process.hrtime.bigint();
      await service
        .passwordLogin(identifier, TEST_PASSWORD, undefined, SOURCE)
        .catch(() => undefined);
      return Number(process.hrtime.bigint() - start) / 1_000_000;
    };

    // Einmal vorwärmen: der Dummy-Hash wird beim ersten Bedarf erzeugt.
    await measure('aufwaermen');

    const known = await measure('sam');
    const unknown = await measure('gibtsnicht');

    // Vorher lag der Faktor bei ~12. Jetzt darf der Unterschied nicht mehr
    // als das Doppelte betragen — Messrauschen bewusst großzügig bedacht.
    const factor = Math.max(known, unknown) / Math.min(known, unknown);
    expect(factor).toBeLessThan(2);
  });

  it('behandelt ein Konto ohne Passwort wie eine unbekannte Kennung', async () => {
    const { service, data } = await buildLogin();
    data.user[0].passwordHash = null;

    await expect(
      service.passwordLogin('sam', TEST_PASSWORD, undefined, SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);
  });

  it('[H3] zählt ein Konto OHNE Passwort nicht auf die Sperre', async () => {
    const { service, data } = await buildLogin();
    data.user[0].passwordHash = null;

    // Wo es kein Geheimnis gibt, kann keines geraten werden. Würde hier
    // gezählt, sperrte ein Angreifer mit fünf Versuchen auch den Passkey-Weg.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await service
        .passwordLogin('sam', 'irgendwas', undefined, SOURCE)
        .catch(() => undefined);
    }

    expect(data.user[0].failedAttempts).toBe(0);
    expect(data.user[0].lockedUntil).toBeNull();
    // Protokolliert wird trotzdem — R6 gilt auch für gescheiterte Versuche.
    expect(
      data.audit.filter((z) => z.action === 'login.password.failure'),
    ).toHaveLength(6);
  });

  it('[H3] verifiziert trotzdem gegen den Dummy-Hash — der Zeitkanal bleibt zu', async () => {
    const { service, data } = await buildLogin();

    const measure = async (prepare: () => void): Promise<number> => {
      prepare();
      const start = process.hrtime.bigint();
      await service
        .passwordLogin('sam', TEST_PASSWORD, undefined, SOURCE)
        .catch(() => undefined);
      return Number(process.hrtime.bigint() - start) / 1_000_000;
    };

    const hash = data.user[0].passwordHash;
    await measure(() => undefined); // vorwärmen
    const withPassword = await measure(() => {
      data.user[0].passwordHash = hash;
    });
    const withoutPassword = await measure(() => {
      data.user[0].passwordHash = null;
    });

    const factor =
      Math.max(withPassword, withoutPassword) / Math.min(withPassword, withoutPassword);
    expect(factor).toBeLessThan(2);
  });
});

describe('[H5] Die eingegebene Kennung wird gekürzt protokolliert', () => {
  it('kürzt lange Eingaben und nennt nur die Länge', () => {
    expect(maskIdentifier('mein-geheimes-passwort')).toBe('mei…(22 Zeichen)');
    expect(maskIdentifier('ab')).toBe('ab…');
    expect(maskIdentifier('   ')).toBe('(ohne Kennung)');
  });

  it('schreibt ein versehentlich ins Kennungsfeld getipptes Passwort nicht ins Log', async () => {
    const { service, data } = await buildLogin();
    const shifted = 'Sommer2026!Geheim';

    await expect(
      service.passwordLogin(shifted, '', undefined, SOURCE),
    ).rejects.toBeDefined();

    expect(JSON.stringify(data.audit)).not.toContain(shifted);
  });
});

describe('[W3] Sitzungen lassen sich entwerten', () => {
  it('zählt die Generation beim Passwortwechsel hoch', async () => {
    const { access, sessionUser, data } = await buildLogin();
    const before = data.user[0].sessionGeneration;

    await access.setPassword(
      sessionUser,
      'ein-frisch-gesetztes-passwort',
      TEST_PASSWORD,
      SOURCE,
    );

    expect(data.user[0].sessionGeneration).toBe(before + 1);
  });

  it('zählt die Generation bei „alle Geräte abmelden" hoch', async () => {
    const { access, sessionUser, data } = await buildLogin();
    const before = data.user[0].sessionGeneration;

    await access.signOutAllDevices(sessionUser, SOURCE);

    expect(data.user[0].sessionGeneration).toBe(before + 1);
    const entry = data.audit.find(
      (z) => z.action === 'device.all_revoked',
    );
    expect(entry?.afterValue).toMatchObject({ sessionsEnded: true });
  });

  it('zählt die Generation beim Notfall-Passwortlink hoch', async () => {
    const { emergency, data } = await buildLogin();
    const before = data.user[0].sessionGeneration;
    const link = await emergency.generateLink('sam', 'password', 'cli:test');
    const token = new URL(link.url).searchParams.get('token') as string;

    await emergency.setPassword(token, 'ein-frisch-gesetztes-passwort', SOURCE);

    expect(data.user[0].sessionGeneration).toBe(before + 1);
  });
});

describe('[W4] Ein neuer Passkey verlangt einen zweiten Faktor', () => {
  it('lässt das aktuelle Passwort als Nachweis gelten', async () => {
    const { access, sessionUser } = await buildLogin();

    await expect(
      access.checkSecondFactor(
        sessionUser.id,
        { currentPassword: TEST_PASSWORD },
        SOURCE,
      ),
    ).resolves.toBeUndefined();
  });

  it('lässt einen TOTP-Code als Nachweis gelten', async () => {
    const { access, sessionUser, secret } = await buildLogin();

    await expect(
      access.checkSecondFactor(
        sessionUser.id,
        { totpCode: totpCode(secret) },
        SOURCE,
      ),
    ).resolves.toBeUndefined();
  });

  it('weist eine Anfrage ohne jeden Nachweis ab, ohne einen Fehlversuch zu zählen', async () => {
    const { access, sessionUser, data } = await buildLogin();

    await expect(
      access.checkSecondFactor(sessionUser.id, {}, SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);
    expect(data.user[0].failedAttempts).toBe(0);
  });

  it('zählt einen falschen Nachweis auf die Kontosperre', async () => {
    const { access, sessionUser, data } = await buildLogin();

    await expect(
      access.checkSecondFactor(
        sessionUser.id,
        { currentPassword: 'zqx-daneben' },
        SOURCE,
      ),
    ).rejects.toBeInstanceOf(LoginFailedError);

    expect(data.user[0].failedAttempts).toBe(1);
    expect(data.audit.some((z) => z.action === 'second_factor.failure')).toBe(true);
  });

  it('setzt den Sperrzähler zurück: falscher Nachweis (1) → richtiger Nachweis (0)', async () => {
    const { access, sessionUser, data } = await buildLogin();

    await expect(
      access.checkSecondFactor(
        sessionUser.id,
        { currentPassword: 'zqx-daneben' },
        SOURCE,
      ),
    ).rejects.toBeInstanceOf(LoginFailedError);
    expect(data.user[0].failedAttempts).toBe(1);

    await expect(
      access.checkSecondFactor(
        sessionUser.id,
        { currentPassword: TEST_PASSWORD },
        SOURCE,
      ),
    ).resolves.toBeUndefined();
    expect(data.user[0].failedAttempts).toBe(0);
    expect(data.user[0].lockedUntil).toBeNull();
  });

  it('räumt auch einen bei der ANMELDUNG vollgelaufenen Zähler ab', async () => {
    const { access, sessionUser, service, data, secret } =
      await buildLogin();

    // Vier Fehlversuche am Anmeldeformular — einer vor der Sperre.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await service
        .passwordLogin('sam', 'zqx-nicht-das-passwort', undefined, SOURCE)
        .catch(() => undefined);
    }
    expect(data.user[0].failedAttempts).toBe(4);

    // Ein erfolgreicher Nachweis an ANDERER Stelle beweist dasselbe Geheimnis
    // und muss denselben Effekt haben — sonst sperrt der nächste Vertipper.
    await access.checkSecondFactor(
      sessionUser.id,
      { totpCode: totpCode(secret) },
      SOURCE,
    );
    expect(data.user[0].failedAttempts).toBe(0);
  });

  it('lässt den Zähler bei frischer Sitzung unberührt — dort wird nichts bewiesen', async () => {
    const { access, sessionUser, service, data } = await buildLogin();
    await service
      .passwordLogin('sam', 'zqx-nicht-das-passwort', undefined, SOURCE)
      .catch(() => undefined);
    expect(data.user[0].failedAttempts).toBe(1);

    // Frische Sitzung überspringt die Prüfung ganz: kein Geheimnis geprüft,
    // also auch kein Grund, den Zähler zurückzusetzen.
    await access.checkSecondFactor(
      sessionUser.id,
      {},
      SOURCE,
      new Date(Date.now() - 60_000),
    );
    expect(data.user[0].failedAttempts).toBe(1);
  });

  it('schreibt den Nachweis nicht ins Audit-Log', async () => {
    const { access, sessionUser, data } = await buildLogin();
    const wrong = 'zqx-mein-falscher-nachweis';

    await expect(
      access.checkSecondFactor(
        sessionUser.id,
        { currentPassword: wrong },
        SOURCE,
      ),
    ).rejects.toBeDefined();

    const everything = JSON.stringify(data.audit);
    expect(everything).not.toContain(wrong);
    expect(everything).not.toContain(TEST_PASSWORD);
    expect(everything).not.toContain('$argon2');
  });

  it('greift auch, wenn nur TOTP eingerichtet ist (kein Passwort)', async () => {
    const { access, sessionUser, data, secret } = await buildLogin();
    data.user[0].passwordHash = null;

    await expect(
      access.checkSecondFactor(
        sessionUser.id,
        { totpCode: totpCode(secret) },
        SOURCE,
      ),
    ).resolves.toBeUndefined();
    await expect(
      access.checkSecondFactor(sessionUser.id, { totpCode: '000000' }, SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);
  });
});

describe('[W4-Nachtrag] Fenster für frische Anmeldung', () => {
  const NOW = new Date('2026-08-30T12:00:00.000Z');
  /** Sitzung, die vor `minuten` Minuten ausgestellt wurde. */
  const beforeMinutes = (minutes: number): Date =>
    new Date(NOW.getTime() - minutes * 60_000);

  it('lässt den Nachweis bei frischer Sitzung entfallen (Ersteinrichtung)', async () => {
    const { access, sessionUser, data } = await buildLogin();

    // Wizard-Schritt 3 sendet keinen Nachweis — und muss trotzdem durchgehen.
    await expect(
      access.checkSecondFactor(
        sessionUser.id,
        {},
        SOURCE,
        beforeMinutes(1),
        NOW,
      ),
    ).resolves.toBeUndefined();

    // Kein Fehlversuch, kein Audit-Eintrag: es ist nichts schiefgegangen.
    expect(data.user[0].failedAttempts).toBe(0);
    expect(data.audit.some((z) => z.action === 'second_factor.failure')).toBe(false);
  });

  it('greift bis kurz vor Ablauf des Fensters', async () => {
    const { access, sessionUser } = await buildLogin();

    await expect(
      access.checkSecondFactor(
        sessionUser.id,
        {},
        SOURCE,
        beforeMinutes(9.9),
        NOW,
      ),
    ).resolves.toBeUndefined();
  });

  it('verlangt den Nachweis bei GEALTERTER Sitzung wieder', async () => {
    const { access, sessionUser } = await buildLogin();

    await expect(
      access.checkSecondFactor(
        sessionUser.id,
        {},
        SOURCE,
        beforeMinutes(11),
        NOW,
      ),
    ).rejects.toBeInstanceOf(LoginFailedError);
  });

  it('lässt eine gealterte Sitzung mit gültigem Nachweis durch', async () => {
    const { access, sessionUser } = await buildLogin();

    await expect(
      access.checkSecondFactor(
        sessionUser.id,
        { currentPassword: TEST_PASSWORD },
        SOURCE,
        beforeMinutes(30),
        NOW,
      ),
    ).resolves.toBeUndefined();
  });

  it('weist einen FALSCHEN Nachweis auch bei gealterter Sitzung ab und zählt ihn', async () => {
    const { access, sessionUser, data } = await buildLogin();

    await expect(
      access.checkSecondFactor(
        sessionUser.id,
        { currentPassword: 'zqx-daneben' },
        SOURCE,
        beforeMinutes(30),
        NOW,
      ),
    ).rejects.toBeInstanceOf(LoginFailedError);

    expect(data.user[0].failedAttempts).toBe(1);
    expect(data.audit.some((z) => z.action === 'second_factor.failure')).toBe(true);
  });

  it('behandelt ein Token OHNE Ausstellungszeitpunkt als nicht frisch', async () => {
    const { access, sessionUser } = await buildLogin();

    // Im Zweifel wird der Nachweis verlangt, nicht darauf verzichtet.
    await expect(
      access.checkSecondFactor(sessionUser.id, {}, SOURCE, null, NOW),
    ).rejects.toBeInstanceOf(LoginFailedError);
  });

  it('traut einem in der ZUKUNFT ausgestellten Token nicht', async () => {
    const { access, sessionUser } = await buildLogin();
    const future = new Date(NOW.getTime() + 60 * 60_000);

    // Sonst liesse sich das Fenster mit einer verstellten Uhr beliebig weiten.
    await expect(
      access.checkSecondFactor(sessionUser.id, {}, SOURCE, future, NOW),
    ).rejects.toBeInstanceOf(LoginFailedError);
  });

  it('umgeht die Kontosperre nicht — gesperrt bleibt gesperrt', async () => {
    const { access, sessionUser, service } = await buildLogin();
    await lockoutAccount(service);

    // Auch mit frischer Sitzung: eine gesperrte Kontosperre gilt. Die
    // Frische-Prüfung steht bewusst VOR dem Laden des Kontos, daher hier der
    // ausdrückliche Gegentest mit gealterter Sitzung.
    await expect(
      access.checkSecondFactor(
        sessionUser.id,
        { currentPassword: TEST_PASSWORD },
        SOURCE,
        beforeMinutes(30),
        NOW,
      ),
    ).rejects.toMatchObject({ errorCode: 'account_locked' });
  });
});

describe('[H1] Der Seed hat eine wirksame Schranke', () => {
  it('nennt die Produktionsdatenbank nicht als Freibrief', async () => {
    const source = await import('fs').then((fs) =>
      fs.readFileSync('prisma/seed.ts', 'utf8'),
    );
    // Die alte Schranke („control" muss in der DATABASE_URL stehen) war
    // wirkungslos, weil die Produktionsdatenbank saas_instant_control heißt.
    expect(source).toContain('CONTROL_SEED_ALLOWED');
    expect(source).not.toContain("url.includes('control')");
  });
});

describe('[H4] Passkey-Optionen passen zur serverseitigen Erwartung', () => {
  it('fordert Nutzerverifikation an, weil der Server sie verlangt', async () => {
    const source = await import('fs').then((fs) =>
      fs.readFileSync('src/auth/passkey.service.ts', 'utf8'),
    );
    expect(source).not.toContain("userVerification: 'preferred'");
    expect(source.match(/userVerification: 'required'/g)).toHaveLength(2);
  });
});

describe('argon2-Hashes bleiben aus jedem Nachweis heraus', () => {
  it('speichert Passwörter nur als argon2id-Hash', async () => {
    const { data } = await buildLogin();
    const hash = data.user[0].passwordHash as string;

    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain(TEST_PASSWORD);
    expect(await argon2.verify(hash, TEST_PASSWORD)).toBe(true);
  });
});
