import {
  LoginFailedError,
  AccountLockedError,
  LastFactorError,
} from '../common/errors/business-error';
import {
  buildLogin,
  TEST_PASSWORD,
  totpCode,
} from '../test-support/login-provisioning';
import { CODE_MAX_FAILED_ATTEMPTS } from './email-login-code.service';
import { MAX_FAILED_ATTEMPTS } from './lockout.service';

// argon2 ist absichtlich langsam; Hashen und Prüfen brauchen mehr als die Vorgabe.
jest.setTimeout(60_000);

const SOURCE = { ip: '203.0.113.9', userAgent: 'Jest' };
/**
 * Nachweis des zweiten Faktors für die Einrichtungsroute ([W3]). Die Sitzung
 * gilt im Test als NICHT frisch, deshalb ist er hier immer nötig.
 */
const EVIDENCE = { currentPassword: TEST_PASSWORD };

/** Baut ein Konto mit eingerichtetem E-Mail-Faktor. */
function build() {
  return buildLogin({ loginCodeEnabled: true });
}

/** Führt Schritt eins aus und liefert den Vorgangstoken. */
async function untilToSecondFactor(
  service: Awaited<ReturnType<typeof build>>['service'],
): Promise<string> {
  const result = await service.passwordLogin(
    'sam',
    TEST_PASSWORD,
    undefined,
    SOURCE,
  );
  if (result.kind !== 'second-factor') {
    throw new Error('Erwartet: zweiter Faktor nötig.');
  }
  return result.flowToken;
}

describe('Anmeldung mit E-Mail-Code — der gute Fall', () => {
  it('nennt den E-Mail-Code als verfügbaren zweiten Faktor', async () => {
    const { service, waitForSend } = await build();

    const result = await service.passwordLogin(
      'sam',
      TEST_PASSWORD,
      undefined,
      SOURCE,
    );

    expect(result.kind).toBe('second-factor');
    if (result.kind === 'second-factor') {
      expect(result.factors).toEqual(['email-code', 'totp']);
    }
  });

  it('verschweigt den E-Mail-Code, solange er nicht eingerichtet ist', async () => {
    const { service, waitForSend } = await buildLogin({ loginCodeEnabled: false });

    const result = await service.passwordLogin(
      'sam',
      TEST_PASSWORD,
      undefined,
      SOURCE,
    );

    if (result.kind !== 'second-factor') throw new Error('Erwartet: 2FA.');
    expect(result.factors).toEqual(['totp']);
  });

  it('verschickt den Code an die Konto-E-Mail und schließt damit die Anmeldung ab', async () => {
    const { service, mailbox, waitForSend } = await build();
    const flow = await untilToSecondFactor(service);

    await service.requestLoginCode('sam', SOURCE);

    await waitForSend();
    expect(mailbox).toHaveLength(1);
    expect(mailbox[0].email).toBe('inhaber@example.com');
    expect(mailbox[0].code).toMatch(/^\d{8}$/);
    expect(mailbox[0].forSetup).toBe(false);

    const done = await service.secondFactorEmailCode(
      flow,
      mailbox[0].code,
      false,
      SOURCE,
    );

    expect(done.kind).toBe('session');
    expect(done.trustedToken).toBeUndefined();
  });

  it('verschickt an die getrennt hinterlegte Adresse, wenn es eine gibt', async () => {
    const { service, mailbox, waitForSend } = await buildLogin({
      loginCodeEnabled: true,
      loginCodeEmail: 'zweitpostfach@example.com',
    });

    await service.requestLoginCode('sam', SOURCE);

    await waitForSend();

    expect(mailbox[0].email).toBe('zweitpostfach@example.com');
  });

  it('merkt das Gerät auf Wunsch', async () => {
    const { service, mailbox, data, waitForSend } = await build();
    const flow = await untilToSecondFactor(service);
    await service.requestLoginCode('sam', SOURCE);
    await waitForSend();

    const done = await service.secondFactorEmailCode(
      flow,
      mailbox[0].code,
      true,
      SOURCE,
    );

    expect(done.trustedToken).toBeDefined();
    expect(data.devices).toHaveLength(1);
  });

  it('setzt den Sperrzähler nach erfolgreicher Anmeldung zurück', async () => {
    const { service, mailbox, data, waitForSend } = await build();
    await service
      .passwordLogin('sam', 'wrong', undefined, SOURCE)
      .catch(() => undefined);
    expect(data.user[0].failedAttempts).toBe(1);

    const flow = await untilToSecondFactor(service);
    await service.requestLoginCode('sam', SOURCE);
    await waitForSend();
    await service.secondFactorEmailCode(
      flow,
      mailbox[0].code,
      false,
      SOURCE,
    );

    expect(data.user[0].failedAttempts).toBe(0);
  });
});

describe('Anmeldung mit E-Mail-Code — Brute-Force-Schutz', () => {
  it('zählt jeden falschen Code auf die KONTOSPERRE und sperrt beim fünften', async () => {
    const { service, mailbox, data, waitForSend } = await build();
    await service.requestLoginCode('sam', SOURCE);
    await waitForSend();
    expect(mailbox).toHaveLength(1);

    for (let attempt = 1; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      const flow = await untilToSecondFactor(service);
      await expect(
        service.secondFactorEmailCode(flow, '00000000', false, SOURCE),
      ).rejects.toBeInstanceOf(LoginFailedError);
      expect(data.user[0].failedAttempts).toBe(attempt);
    }

    const last = await untilToSecondFactor(service);
    await expect(
      service.secondFactorEmailCode(last, '00000000', false, SOURCE),
    ).rejects.toBeInstanceOf(AccountLockedError);
    expect(data.user[0].lockedUntil).not.toBeNull();
  });

  // Der Testname interpoliert die Konstante, statt eine Zahl zu behaupten —
  // dasselbe Muster wie in `mail.service.ts` ([W9]).
  it(`verbrennt den Code nach ${CODE_MAX_FAILED_ATTEMPTS} Fehlversuchen — auch der richtige gilt dann nicht mehr`, async () => {
    const { service, mailbox, data, lockout, waitForSend } = await build();
    const flow = await untilToSecondFactor(service);
    await service.requestLoginCode('sam', SOURCE);
    await waitForSend();
    const correct = mailbox[0].code;

    for (let attempt = 0; attempt < CODE_MAX_FAILED_ATTEMPTS; attempt += 1) {
      await service
        .secondFactorEmailCode(flow, '00000000', false, SOURCE)
        .catch(() => undefined);
    }
    expect(data.emailCodes[0].failedAttempts).toBe(CODE_MAX_FAILED_ATTEMPTS);

    // Kontosperre aufheben, damit wirklich der CODE geprüft wird und nicht die
    // Sperre den Versuch schon vorher abfängt.
    await lockout.setBack(data.user[0].id);
    const again = await untilToSecondFactor(service);
    await expect(
      service.secondFactorEmailCode(again, correct, false, SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);
  });

  it('weist einen abgelaufenen Code ab', async () => {
    const { service, mailbox, codesByMail, data, waitForSend } = await build();
    const flow = await untilToSecondFactor(service);
    await service.requestLoginCode('sam', SOURCE);
    await waitForSend();

    // Ablauf vorziehen — dieselbe Wirkung wie zehn Minuten Wartezeit.
    data.emailCodes[0].expiresAt = new Date(Date.now() - 1000);

    await expect(
      service.secondFactorEmailCode(flow, mailbox[0].code, false, SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);
    expect(
      (await codesByMail.resolve(data.user[0].id, mailbox[0].code, false))
        .kind,
    ).toBe('expired');
  });

  it('lässt denselben Code kein zweites Mal gelten', async () => {
    const { service, mailbox, waitForSend } = await build();
    await service.requestLoginCode('sam', SOURCE);
    await waitForSend();

    const firstFlow = await untilToSecondFactor(service);
    await service.secondFactorEmailCode(
      firstFlow,
      mailbox[0].code,
      false,
      SOURCE,
    );

    const secondFlow = await untilToSecondFactor(service);
    await expect(
      service.secondFactorEmailCode(
        secondFlow,
        mailbox[0].code,
        false,
        SOURCE,
      ),
    ).rejects.toBeInstanceOf(LoginFailedError);
  });

  it('verschickt bei erneutem Anfordern innerhalb von 60 Sekunden keine zweite Mail', async () => {
    const { service, mailbox, waitForSend } = await build();

    await service.requestLoginCode('sam', SOURCE);

    await waitForSend();
    await service.requestLoginCode('sam', SOURCE);
    await waitForSend();

    expect(mailbox).toHaveLength(1);
  });

  it('weist den Code ab, wenn der Faktor gar nicht eingerichtet ist', async () => {
    const { service, waitForSend } = await buildLogin({ loginCodeEnabled: false });
    const flow = await untilToSecondFactor(service);

    await expect(
      service.secondFactorEmailCode(flow, '12345678', false, SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);
  });

  it('lässt ein gesperrtes Konto auch mit richtigem Code nicht durch', async () => {
    const { service, mailbox, data, waitForSend } = await build();
    const flow = await untilToSecondFactor(service);
    await service.requestLoginCode('sam', SOURCE);
    await waitForSend();
    data.user[0].lockedUntil = new Date(Date.now() + 60_000);

    await expect(
      service.secondFactorEmailCode(flow, mailbox[0].code, false, SOURCE),
    ).rejects.toBeInstanceOf(AccountLockedError);
  });
});

describe('Anfordern verrät nicht, ob es die Kennung gibt', () => {
  it('antwortet bei unbekannter Kennung genauso — ohne Fehler, ohne Mail', async () => {
    const { service, mailbox, waitForSend } = await build();

    await expect(
      service.requestLoginCode('gibtesnicht', SOURCE),
    ).resolves.toBeUndefined();
    expect(mailbox).toHaveLength(0);
  });

  it('antwortet auch bei nicht eingerichtetem Faktor gleich', async () => {
    const { service, mailbox, waitForSend } = await buildLogin({ loginCodeEnabled: false });

    await expect(
      service.requestLoginCode('sam', SOURCE),
    ).resolves.toBeUndefined();
    expect(mailbox).toHaveLength(0);
  });

  it('antwortet auch innerhalb der 60-Sekunden-Sperre gleich', async () => {
    const { service, waitForSend } = await build();
    await service.requestLoginCode('sam', SOURCE);
    await waitForSend();

    await expect(
      service.requestLoginCode('sam', SOURCE),
    ).resolves.toBeUndefined();
  });

  it('braucht für eine unbekannte Kennung nicht messbar weniger Zeit', async () => {
    // Ohne die Zeitangleichung käme die Antwort hier in Millisekunden, beim
    // echten Konto erst nach ~100 ms argon2 — das wäre über das Netz ablesbar.
    const { service, waitForSend } = await build();

    const beforeKnown = Date.now();
    await service.requestLoginCode('sam', SOURCE);
    await waitForSend();
    const known = Date.now() - beforeKnown;

    const beforeUnknown = Date.now();
    await service.requestLoginCode('gibtesnicht', SOURCE);
    await waitForSend();
    const unknown = Date.now() - beforeUnknown;

    // Grosszügige Schranke: es geht um Größenordnungen, nicht um Millisekunden.
    expect(unknown).toBeGreaterThan(known / 4);
  });

  it('protokolliert den Fehlschlag mit maskierter Kennung', async () => {
    const { service, data, waitForSend } = await build();

    await service.requestLoginCode('geheimer-benutzername', SOURCE);

    await waitForSend();

    const entry = data.audit.find(
      (line) => line.action === 'login_code.not_sent',
    );
    expect(entry).toBeDefined();
    expect(entry?.actor).not.toContain('geheimer-benutzername');
    expect(entry?.userId).toBeNull();
  });
});

describe('Im Audit-Log steht niemals ein Code', () => {
  it('nicht beim Anfordern, nicht bei Fehlversuch, nicht bei Erfolg', async () => {
    const { service, mailbox, data, waitForSend } = await build();
    await service.requestLoginCode('sam', SOURCE);
    await waitForSend();
    const code = mailbox[0].code;

    const flow = await untilToSecondFactor(service);
    await service
      .secondFactorEmailCode(flow, '00000000', false, SOURCE)
      .catch(() => undefined);

    const second = await untilToSecondFactor(service);
    await service.secondFactorEmailCode(second, code, false, SOURCE);

    // Es muss auch wirklich etwas protokolliert worden sein — sonst wäre der
    // Test trivial erfüllt.
    const actions = data.audit.map((line) => line.action);
    expect(actions).toContain('login_code.requested');
    expect(actions).toContain('login.email_code.failure');
    expect(actions).toContain('login.email_code.success');

    const everything = JSON.stringify(data.audit);
    expect(everything).not.toContain(code);
    // Auch der falsch geratene Code darf nirgends stehen.
    expect(everything).not.toContain('00000000');
  });

  it('schreibt auch keinen Hash ins Audit-Log', async () => {
    const { service, data, waitForSend } = await build();
    await service.requestLoginCode('sam', SOURCE);
    await waitForSend();

    expect(JSON.stringify(data.audit)).not.toContain('$argon2id$');
  });
});

describe('[W1] Ein kaputter Postausgang ist KEIN Aufzählungskanal', () => {
  it('antwortet trotz Versandfehler ganz normal — sonst wäre es ein Ja/Nein-Orakel', async () => {
    // Vorher: `test` bekam 502, `gibtesnicht` 200. Damit lieferte die anonyme
    // Route auf Zuruf eine Existenzauskunft, sobald der Relay klemmte.
    const { service, setSendBroken, waitForSend } = await build();
    setSendBroken(true);

    await expect(
      service.requestLoginCode('sam', SOURCE),
    ).resolves.toBeUndefined();
    await waitForSend();

    await expect(
      service.requestLoginCode('gibtesnicht', SOURCE),
    ).resolves.toBeUndefined();
  });

  it('verwirft den Code, damit die 60-Sekunden-Sperre nicht gegen den Benutzer läuft', async () => {
    const { service, data, setSendBroken, mailbox, waitForSend } =
      await build();
    setSendBroken(true);

    await service.requestLoginCode('sam', SOURCE);
    await waitForSend();
    expect(data.emailCodes).toHaveLength(0);

    setSendBroken(false);
    await service.requestLoginCode('sam', SOURCE);
    await waitForSend();
    expect(mailbox).toHaveLength(1);
  });

  it('protokolliert den Fehlschlag, damit er nicht still bleibt', async () => {
    const { service, data, setSendBroken, waitForSend } = await build();
    setSendBroken(true);

    await service.requestLoginCode('sam', SOURCE);
    await waitForSend();

    const entry = data.audit.find(
      (z) =>
        z.action === 'login_code.not_sent' &&
        JSON.stringify(z.afterValue).includes('Postausgang'),
    );
    expect(entry).toBeDefined();
  });
});

describe('Der letzte zweite Faktor lässt sich nicht entfernen', () => {
  it('weist das Entfernen von TOTP ab, wenn es der einzige Faktor ist', async () => {
    const { access, sessionUser, waitForSend } = await buildLogin({
      loginCodeEnabled: false,
    });

    await expect(
      access.factorRemove(sessionUser, 'totp', SOURCE),
    ).rejects.toBeInstanceOf(LastFactorError);
  });

  it('weist das Entfernen des E-Mail-Codes ab, wenn er der einzige Faktor ist', async () => {
    const { access, sessionUser, data, waitForSend } = await build();
    data.user[0].totpSecret = null;

    await expect(
      access.factorRemove(sessionUser, 'email-code', SOURCE),
    ).rejects.toBeInstanceOf(LastFactorError);
    expect(data.user[0].loginCodeEnabled).toBe(true);
  });

  it('weist auch den Widerruf des letzten Passkeys ab', async () => {
    const { access, sessionUser, data, waitForSend } = await buildLogin({
      loginCodeEnabled: false,
    });
    data.user[0].totpSecret = null;
    data.passkeys.push({
      id: 'pk-1',
      userId: data.user[0].id,
      credentialId: 'cred-1',
      publicKey: 'oeffentlich',
      counter: 0,
      transports: null,
      label: 'Telefon',
      createdAt: new Date(),
      lastUsedAt: null,
    });

    await expect(
      access.revoke(sessionUser, 'passkey:pk-1', EVIDENCE, SOURCE),
    ).rejects.toBeInstanceOf(LastFactorError);
    expect(data.passkeys).toHaveLength(1);
  });

  it('protokolliert die Ablehnung', async () => {
    const { access, sessionUser, data, waitForSend } = await buildLogin({
      loginCodeEnabled: false,
    });

    await access
      .factorRemove(sessionUser, 'totp', SOURCE)
      .catch(() => undefined);

    expect(
      data.audit.some((z) => z.action === 'factor.removal_rejected'),
    ).toBe(true);
  });

  it('erlaubt das Entfernen, sobald ein zweiter Faktor daneben steht', async () => {
    const { access, sessionUser, data, waitForSend } = await build();
    data.devices.push({
      id: 'g-1',
      userId: data.user[0].id,
      label: 'Merk-Gerät',
      tokenHash: 'egal',
      createdAt: new Date(),
      lastSeenAt: new Date(),
      validUntil: new Date(Date.now() + 86_400_000),
    });

    const result = await access.factorRemove(
      sessionUser,
      'totp',
      SOURCE,
    );

    expect(data.user[0].totpSecret).toBeNull();
    expect(data.user[0].loginCodeEnabled).toBe(true);
    // Ein schwächer gewordener Zugang lässt keine Merk-Geräte im Umlauf.
    expect(result.invalidatedTrustedDevices).toBe(1);
    expect(data.devices).toHaveLength(0);
  });

  it('räumt beim Entfernen des E-Mail-Faktors auch offene Codes weg', async () => {
    const { service, access, sessionUser, data, waitForSend } = await build();
    await service.requestLoginCode('sam', SOURCE);
    await waitForSend();
    expect(data.emailCodes).toHaveLength(1);

    await access.factorRemove(sessionUser, 'email-code', SOURCE);

    expect(data.emailCodes).toHaveLength(0);
    expect(data.user[0].loginCodeEnabled).toBe(false);
    expect(data.user[0].loginCodeEmail).toBeNull();
  });
});

describe('Faktor „Code per E-Mail" einrichten', () => {
  it('übernimmt die Adresse ERST mit der Bestätigung', async () => {
    const { access, sessionUser, data, mailbox, waitForSend } = await buildLogin({
      loginCodeEnabled: false,
    });

    const started = await access.emailCodeSetup(sessionUser, 'Neu@Example.com', SOURCE);

    expect(started.email).toBe('neu@example.com');
    expect(mailbox[0].forSetup).toBe(true);
    // Noch NICHTS am Konto geändert — ein Tippfehler darf nicht aussperren.
    expect(data.user[0].loginCodeEnabled).toBe(false);
    expect(data.user[0].loginCodeEmail).toBeNull();

    await access.emailCodeConfirm(
      sessionUser,
      mailbox[0].code,
      SOURCE,
    );

    expect(data.user[0].loginCodeEnabled).toBe(true);
    expect(data.user[0].loginCodeEmail).toBe('neu@example.com');
  });

  it('weist einen falschen Bestätigungscode ab, ohne das Konto zu sperren', async () => {
    const { access, sessionUser, data, waitForSend } = await buildLogin({
      loginCodeEnabled: false,
    });
    await access.emailCodeSetup(sessionUser, undefined, SOURCE);

    await expect(
      access.emailCodeConfirm(sessionUser, '00000000', SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);

    expect(data.user[0].failedAttempts).toBe(0);
    expect(data.user[0].lockedUntil).toBeNull();
    expect(data.user[0].loginCodeEnabled).toBe(false);
  });

  it('nimmt ohne Wunschadresse die Konto-E-Mail', async () => {
    const { access, sessionUser, mailbox, waitForSend } = await buildLogin({
      loginCodeEnabled: false,
    });

    const started = await access.emailCodeSetup(sessionUser, undefined, SOURCE);

    expect(started.email).toBe('inhaber@example.com');
    expect(mailbox[0].email).toBe('inhaber@example.com');
  });

  it('lässt einen Anmeldecode nicht als Einrichtungscode durchgehen', async () => {
    const { service, access, sessionUser, mailbox, waitForSend } = await build();
    await service.requestLoginCode('sam', SOURCE);
    await waitForSend();

    await expect(
      access.emailCodeConfirm(sessionUser, mailbox[0].code, SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);
  });

  it('protokolliert die Einrichtung ohne den Code', async () => {
    const { access, sessionUser, data, mailbox, waitForSend } = await buildLogin({
      loginCodeEnabled: false,
    });
    await access.emailCodeSetup(sessionUser, undefined, SOURCE);
    await access.emailCodeConfirm(
      sessionUser,
      mailbox[0].code,
      SOURCE,
    );

    const entry = data.audit.find(
      (line) => line.action === 'login_code.set_up',
    );
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toContain(mailbox[0].code);
  });
});

describe('Faktorenübersicht', () => {
  it('nennt jeden Faktor mit Zustand und Entfernbarkeit', async () => {
    const { access, sessionUser, waitForSend } = await build();

    const overview = await access.factors(sessionUser.id);

    expect(overview.countSetUp).toBe(2);
    const byKind = Object.fromEntries(
      overview.factors.map((entry) => [entry.kind, entry]),
    );
    expect(byKind['email-code'].setUp).toBe(true);
    expect(byKind['email-code'].email).toBe('inhaber@example.com');
    expect(byKind['email-code'].removable).toBe(true);
    expect(byKind['totp'].setUp).toBe(true);
    expect(byKind['totp'].removable).toBe(true);
    expect(byKind['passkey'].setUp).toBe(false);
    expect(byKind['passkey'].count).toBe(0);
    expect(byKind['passkey'].removable).toBe(false);
  });

  it('markiert den einzigen Faktor als nicht entfernbar', async () => {
    const { access, sessionUser, waitForSend } = await buildLogin({
      loginCodeEnabled: false,
    });

    const overview = await access.factors(sessionUser.id);

    expect(overview.countSetUp).toBe(1);
    const totp = overview.factors.find((e) => e.kind === 'totp');
    expect(totp?.setUp).toBe(true);
    expect(totp?.removable).toBe(false);
  });
});

describe('[W3] Die Zustelladresse wird erst mit der Bestaetigung uebernommen', () => {
  it('lässt sie mit richtigem Passwort zu', async () => {
    const { access, sessionUser, mailbox } = await build();

    await access.emailCodeSetup(sessionUser, 'zweit@example.com', SOURCE);

    expect(mailbox).toHaveLength(1);
    expect(mailbox[0].email).toBe('zweit@example.com');
  });

  it('lässt sie bei FRISCHER Sitzung ohne Nachweis zu (Ersteinrichtung)', async () => {
    const { access, sessionUser, mailbox } = await buildLogin({
      loginCodeEnabled: false,
    });

    await access.emailCodeSetup(sessionUser, undefined, SOURCE);

    expect(mailbox).toHaveLength(1);
  });

  it('warnt die BISHERIGE Adresse, sobald sich die Zustelladresse ändern soll', async () => {
    const { access, sessionUser, notes, data } = await build();

    await access.emailCodeSetup(sessionUser, 'angreifer@fremde-domain.example.com', SOURCE);

    expect(notes).toHaveLength(1);
    expect(notes[0].to).toBe('inhaber@example.com');
    expect(notes[0].newAddress).toBe('angreifer@fremde-domain.example.com');
    expect(
      data.audit.some(
        (z) => z.action === 'login_code.address_change_requested',
      ),
    ).toBe(true);
  });

  it('warnt NICHT, wenn die Adresse dieselbe bleibt — die Warnung läge im selben Postfach', async () => {
    const { access, sessionUser, notes } = await build();

    await access.emailCodeSetup(sessionUser, 'inhaber@example.com', SOURCE);

    expect(notes).toHaveLength(0);
  });

  it('warnt NICHT bei der ERSTeinrichtung — es gibt keine bisherige Adresse', async () => {
    const { access, sessionUser, notes } = await buildLogin({
      loginCodeEnabled: false,
    });

    await access.emailCodeSetup(sessionUser, 'erst@example.com', SOURCE);

    expect(notes).toHaveLength(0);
  });
});

describe('[H1] Ein Anmeldevorgang gilt genau einmal', () => {
  it('schließt mit demselben Vorgangstoken kein zweites Mal eine Anmeldung ab', async () => {
    const { service, mailbox, waitForSend } = await build();
    const flow = await untilToSecondFactor(service);

    await service.requestLoginCode('sam', SOURCE);
    await waitForSend();
    await service.secondFactorEmailCode(
      flow,
      mailbox[0].code,
      false,
      SOURCE,
    );

    // Zweiter Anlauf mit DEMSELBEN Token und einem frischen Code.
    const secondFlow = await untilToSecondFactor(service);
    expect(secondFlow).not.toBe(flow);
    await expect(
      service.secondFactorEmailCode(flow, '12345678', false, SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);
  });

  it('entwertet auch den TOTP-Weg mit demselben verbrauchten Token', async () => {
    const { service, secret } = await build();
    const flow = await untilToSecondFactor(service);
    await service.secondFactorTotp(flow, totpCode(secret), false, SOURCE);

    await expect(
      service.secondFactorTotp(flow, totpCode(secret), false, SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);
  });
});

describe('[DW1] Der Fehlergrund geht als detail mit hinaus', () => {
  /** Liest `detail.grund` aus einem gefangenen Fehler. */
  function reasonOfError(error: unknown): unknown {
    const response = (error as { getResponse: () => unknown }).getResponse();
    return (response as { detail?: { reason?: unknown } }).detail?.reason;
  }

  it('meldet „falsch" beim ersten Vertipper', async () => {
    const { service, waitForSend } = await build();
    const flow = await untilToSecondFactor(service);
    await service.requestLoginCode('sam', SOURCE);
    await waitForSend();

    const error = await service
      .secondFactorEmailCode(flow, '00000000', false, SOURCE)
      .catch((f: unknown) => f);

    expect(reasonOfError(error)).toBe('wrong');
  });

  it('meldet „verbrannt" nach dem fünften Fehlversuch', async () => {
    const { service, data, lockout, waitForSend } = await build();
    await service.requestLoginCode('sam', SOURCE);
    await waitForSend();

    let lastError: unknown;
    for (let attempt = 0; attempt < CODE_MAX_FAILED_ATTEMPTS; attempt += 1) {
      await lockout.setBack(data.user[0].id);
      const flow = await untilToSecondFactor(service);
      lastError = await service
        .secondFactorEmailCode(flow, '00000000', false, SOURCE)
        .catch((f: unknown) => f);
    }

    expect(reasonOfError(lastError)).toBe('burned');
  });

  it('meldet „abgelaufen" bei abgelaufenem Code', async () => {
    const { service, mailbox, data, waitForSend } = await build();
    const flow = await untilToSecondFactor(service);
    await service.requestLoginCode('sam', SOURCE);
    await waitForSend();
    data.emailCodes[0].expiresAt = new Date(Date.now() - 1000);

    const error = await service
      .secondFactorEmailCode(flow, mailbox[0].code, false, SOURCE)
      .catch((f: unknown) => f);

    expect(reasonOfError(error)).toBe('expired');
  });

  it('lässt das detail weg, wenn gar kein Code angefordert wurde', async () => {
    const { service } = await build();
    const flow = await untilToSecondFactor(service);

    const error = await service
      .secondFactorEmailCode(flow, '12345678', false, SOURCE)
      .catch((f: unknown) => f);

    expect(reasonOfError(error)).toBeUndefined();
  });

  it('reicht NIE die Zahl der Fehlversuche heraus', async () => {
    const { service, waitForSend } = await build();
    const flow = await untilToSecondFactor(service);
    await service.requestLoginCode('sam', SOURCE);
    await waitForSend();

    const error = await service
      .secondFactorEmailCode(flow, '00000000', false, SOURCE)
      .catch((f: unknown) => f);

    const response = JSON.stringify(
      (error as { getResponse: () => unknown }).getResponse(),
    );
    expect(response).not.toContain('failedAttempts');
    expect(response).not.toContain('remaining');
  });

  it('meldet den Grund auch auf dem EINRICHTUNGSweg', async () => {
    const { access, sessionUser, waitForSend } = await buildLogin({
      loginCodeEnabled: false,
    });
    await access.emailCodeSetup(sessionUser, undefined, SOURCE);
    await waitForSend();

    const error = await access
      .emailCodeConfirm(sessionUser, '00000000', SOURCE)
      .catch((f: unknown) => f);

    expect(reasonOfError(error)).toBe('wrong');
  });
});

describe('[K1] Eine erneuerte Sitzung ist nicht wieder frisch', () => {
  it('verlangt den Nachweis weiter, wenn der Nachweis alt ist — egal wie jung das Token', async () => {
    // Kern von [K1]: `pruefeZweitenFaktor` rechnet gegen `auth_time`, nicht
    // gegen `iat`. Ein gerade erneuertes Token traegt ein frisches `iat` und
    // einen ALTEN Nachweiszeitpunkt — der Nachweis muss trotzdem kommen.
    const { access, sessionUser } = await build();
    const beforeYesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);

    await expect(
      access.checkSecondFactor(
        sessionUser.id,
        {},
        SOURCE,
        beforeYesterday,
      ),
    ).rejects.toBeInstanceOf(LoginFailedError);
  });

  it('laesst einen frischen Nachweis durch', async () => {
    const { access, sessionUser } = await build();

    await expect(
      access.checkSecondFactor(sessionUser.id, {}, SOURCE, new Date()),
    ).resolves.toBeUndefined();
  });

  it('behandelt eine Sitzung ohne Nachweiszeitpunkt als nicht frisch', async () => {
    const { access, sessionUser } = await build();

    await expect(
      access.checkSecondFactor(sessionUser.id, {}, SOURCE, null),
    ).rejects.toBeInstanceOf(LoginFailedError);
  });
});

describe('[K3] Die Ersteinrichtung behaelt ihre Sitzung', () => {
  it('gibt nach dem Setzen des Passworts ein neues Sitzungstoken zurueck', async () => {
    // Ohne das folgt auf 200 sofort 401: `entwerteAlleSitzungen` trifft auch
    // die Sitzung, aus der heraus gehandelt wurde. In der Ersteinrichtung
    // brach damit der Wizard nach Schritt 1 ab.
    const { access, sessionUser, data } = await buildLogin({
      loginCodeEnabled: false,
    });
    const generationBefore = data.user[0].sessionGeneration;

    const result = await access.setPassword(
      sessionUser,
      'ein-ganz-neues-langes-passwort',
      TEST_PASSWORD,
      SOURCE,
    );

    // Alle alten Sitzungen sind entwertet …
    expect(data.user[0].sessionGeneration).toBe(generationBefore + 1);
    // … und es gibt Ersatz.
    expect(typeof result.sessionToken).toBe('string');
    expect(result.sessionToken.length).toBeGreaterThan(0);
  });

  it('gibt auch bei der ERSTvergabe ohne aktuelles Passwort eines zurueck', async () => {
    const { access, sessionUser, data } = await buildLogin({
      loginCodeEnabled: false,
    });
    data.user[0].passwordHash = null;

    const result = await access.setPassword(
      sessionUser,
      'ein-ganz-neues-langes-passwort',
      undefined,
      SOURCE,
      new Date(),
    );

    expect(result.sessionToken.length).toBeGreaterThan(0);
  });
});

describe('[W1] Der Code verbrennt VOR der Kontosperre', () => {
  it('haelt den Codezaehler echt unter dem Kontozaehler', () => {
    // Standen beide auf 5, lief die Kontosperre im Gleichschritt mit und
    // `KontoGesperrtFehler` verdraengte die Verbrannt-Meldung.
    expect(CODE_MAX_FAILED_ATTEMPTS).toBeLessThan(MAX_FAILED_ATTEMPTS);
  });

  it('zeigt „verbrannt", bevor das Konto gesperrt wird', async () => {
    const { service, data, waitForSend } = await build();
    await service.requestLoginCode('sam', SOURCE);
    await waitForSend();

    let lastError: unknown;
    for (let attempt = 0; attempt < CODE_MAX_FAILED_ATTEMPTS; attempt += 1) {
      const flow = await untilToSecondFactor(service);
      lastError = await service
        .secondFactorEmailCode(flow, '00000000', false, SOURCE)
        .catch((f: unknown) => f);
    }

    // Der Code ist tot …
    expect(data.emailCodes[0].failedAttempts).toBe(CODE_MAX_FAILED_ATTEMPTS);
    // … das Konto aber noch offen, und die Meldung ist die richtige.
    expect(data.user[0].lockedUntil).toBeNull();
    expect(lastError).toBeInstanceOf(LoginFailedError);
    const response = (
      lastError as { getResponse: () => { detail?: { reason?: string } } }
    ).getResponse();
    expect(response.detail?.reason).toBe('burned');
  });

  it('[H1] bleibt auch beim NAECHSTEN Versuch bei „verbrannt"', async () => {
    // Vorher fiel jeder weitere Versuch auf `kein_code` und die generische
    // Meldung zurueck — der Benutzer probierte an einem toten Code weiter.
    const { service, data, lockout, waitForSend } = await build();
    await service.requestLoginCode('sam', SOURCE);
    await waitForSend();
    for (let attempt = 0; attempt < CODE_MAX_FAILED_ATTEMPTS; attempt += 1) {
      const flow = await untilToSecondFactor(service);
      await service
        .secondFactorEmailCode(flow, '00000000', false, SOURCE)
        .catch(() => undefined);
    }
    await lockout.setBack(data.user[0].id);

    const again = await untilToSecondFactor(service);
    const error = await service
      .secondFactorEmailCode(again, '00000000', false, SOURCE)
      .catch((f: unknown) => f);

    const response = (
      error as { getResponse: () => { detail?: { reason?: string } } }
    ).getResponse();
    expect(response.detail?.reason).toBe('burned');
  });
});

describe('[W2] Ein gescheiterter Versand reisst keinen fremden Code mit', () => {
  it('verwirft nur die eigene Zeile, nicht den inzwischen zugestellten Code', async () => {
    // Der gemessene Ablauf: Anforderung A haengt im Versand, 60 s spaeter
    // erzeugt Anforderung B einen neuen Code und stellt ihn zu, DANN scheitert
    // A — und riss vorher die Zeile von B mit.
    const { service, data, setSendBroken, waitForSend, codesByMail } =
      await build();
    const userId = data.user[0].id;

    // A: scheitert.
    setSendBroken(true);
    const a = await codesByMail.request(userId, 'ziel@example.com', false);
    if (a.kind !== 'generated') throw new Error('A nicht erzeugt');

    // B: ueberschreibt die Zeile 60 s spaeter und wird zugestellt.
    setSendBroken(false);
    const later = new Date(Date.now() + 61_000);
    const b = await codesByMail.request(
      userId,
      'ziel@example.com',
      false,
      later,
    );
    if (b.kind !== 'generated') throw new Error('B nicht erzeugt');

    // Jetzt erst faellt A auf die Nase — und darf B nicht anfassen.
    await codesByMail.discard(a.codeId, a.createdAt);
    await waitForSend();

    expect(data.emailCodes).toHaveLength(1);
    expect(
      (await codesByMail.resolve(userId, b.code, false, later)).kind,
    ).toBe('ok');
  });
});

describe('[W4] Der Passkey-Zweig von widerrufe prueft den Nachweis selbst', () => {
  it('entfernt TOTP, sobald der Guard den Nachweis durchgelassen hat', async () => {
    // Die Nachweispflicht selbst prueft `zweitfaktor.guard.spec.ts` — hier geht
    // es nur darum, dass die Entfernung danach wirklich greift.
    const { access, sessionUser, data } = await build();

    await access.factorRemove(sessionUser, 'totp', SOURCE);

    expect(data.user[0].totpSecret).toBeNull();
  });

  it('weist auch den Widerruf eines PASSKEYS ohne Nachweis ab', async () => {
    const { access, sessionUser, data } = await build();
    data.passkeys.push({
      id: 'pk-9',
      userId: data.user[0].id,
      credentialId: 'cred-9',
      publicKey: 'oeffentlich',
      counter: 0,
      transports: null,
      label: 'Telefon',
      createdAt: new Date(),
      lastUsedAt: null,
    });

    await expect(
      access.revoke(sessionUser, 'passkey:pk-9', {}, SOURCE),
    ).rejects.toBeInstanceOf(LoginFailedError);

    expect(data.passkeys).toHaveLength(1);
  });

  it('verlangt fuer ein MERK-GERAET keinen Nachweis — das nimmt nichts weg', async () => {
    const { access, sessionUser, data } = await build();
    data.devices.push({
      id: 'g-9',
      userId: data.user[0].id,
      label: 'Merk-Gerät',
      tokenHash: 'egal',
      createdAt: new Date(),
      lastSeenAt: new Date(),
      validUntil: new Date(Date.now() + 86_400_000),
    });

    const result = await access.revoke(
      sessionUser,
      'trusted_device:g-9',
      {},
      SOURCE,
    );

    expect(result.kind).toBe('trusted_device');
    expect(data.devices).toHaveLength(0);
  });
});

describe('[H2] Ein laufender Einrichtungscode ist vor der anonymen Route sicher', () => {
  it('laesst einen Anmeldecode den Einrichtungscode nicht ueberschreiben', async () => {
    // Die Anforderungsroute ist anonym, es genuegt die Kennung. Ohne Schutz
    // koennte ein Fremder die Einrichtung des zweiten Faktors beliebig oft
    // abwuergen.
    const { access, sessionUser, codesByMail, data, mailbox } =
      await buildLogin({ loginCodeEnabled: false });
    await access.emailCodeSetup(sessionUser, 'neu@example.com', SOURCE);
    const setupCode = mailbox[0].code;

    const later = new Date(Date.now() + 61_000);
    const disruption = await codesByMail.request(
      data.user[0].id,
      'inhaber@example.com',
      false,
      later,
    );

    expect(disruption.kind).toBe('too_early');
    // Der Einrichtungscode lebt noch.
    expect(
      (
        await codesByMail.resolve(
          data.user[0].id,
          setupCode,
          true,
          later,
        )
      ).kind,
    ).toBe('ok');
  });

  it('laesst die Einrichtung selbst sehr wohl ueberschreiben', async () => {
    const { codesByMail, data } = await build();
    const userId = data.user[0].id;
    await codesByMail.request(userId, 'a@example.com', false);

    const later = new Date(Date.now() + 61_000);
    const fresh = await codesByMail.request(
      userId,
      'b@example.com',
      true,
      later,
    );

    expect(fresh.kind).toBe('generated');
  });
});
