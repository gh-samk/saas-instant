import { ContactFields } from '../companies/company.service';
import {
  buildLogin,
  TEST_PASSWORD,
  totpCode,
} from '../test-support/login-provisioning';
import { REMOVED, sanitizeForAudit } from './audit.service';

jest.setTimeout(30_000);

const SOURCE = { ip: '203.0.113.11', userAgent: 'Jest' };

describe('sanitizeForAudit', () => {
  it('entfernt Werte, deren Feldname nach einem Geheimnis aussieht', () => {
    const sanitized = sanitizeForAudit({
      totpSecret: 'JBSWY3DPEHPK3PXP',
      password: 'streng-geheim',
      passwordHash: '$argon2id$v=19$...',
      trustedToken: 'abcdef',
      tokenHash: 'deadbeef',
      challenge: 'chal-123',
      recoveryCode: 'abcd-efgh',
      publicKey: 'AAAA',
      label: 'Merk-Gerät · Chrome auf macOS',
      failedAttempts: 3,
    });

    expect(sanitized).toEqual({
      totpSecret: REMOVED,
      password: REMOVED,
      passwordHash: REMOVED,
      trustedToken: REMOVED,
      tokenHash: REMOVED,
      challenge: REMOVED,
      recoveryCode: REMOVED,
      publicKey: REMOVED,
      label: 'Merk-Gerät · Chrome auf macOS',
      failedAttempts: 3,
    });
  });

  it('greift auch verschachtelt und in Listen', () => {
    const sanitized = sanitizeForAudit({
      device: { label: 'Test', tokenHash: 'geheim' },
      list: [{ code: 'abcd-efgh' }],
    });

    expect(sanitized).toEqual({
      device: { label: 'Test', tokenHash: REMOVED },
      list: [{ code: REMOVED }],
    });
  });
});

describe('Audit-Log enthält keine Geheimnisse (R6)', () => {
  it('protokolliert gescheiterte Anmeldungen mit Kennung, aber ohne das Passwort', async () => {
    const { service, data } = await buildLogin();

    await expect(
      service.passwordLogin('sam', 'mein-falsches-passwort', undefined, SOURCE),
    ).rejects.toBeDefined();

    const entry = data.audit.find(
      (line) => line.action === 'login.password.failure',
    );
    expect(entry).toBeDefined();
    expect(entry?.actor).toBe('sam');
    expect(entry?.ip).toBe('203.0.113.11');
    expect(entry?.userAgent).toBe('Jest');

    const everything = JSON.stringify(data.audit);
    expect(everything).not.toContain('mein-falsches-passwort');
    expect(everything).not.toContain(data.user[0].passwordHash);
  });

  it('protokolliert einen falschen TOTP-Code, ohne den Code oder das Geheimnis zu speichern', async () => {
    const { service, data, secret } = await buildLogin();

    const step1 = await service.passwordLogin(
      'sam',
      TEST_PASSWORD,
      undefined,
      SOURCE,
    );
    if (step1.kind !== 'second-factor') throw new Error('unerwartet');

    await expect(
      service.secondFactorTotp(step1.flowToken, '123456', false, SOURCE),
    ).rejects.toBeDefined();

    const everything = JSON.stringify(data.audit);
    expect(everything).not.toContain('123456');
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain(step1.flowToken);
  });

  it('enthält nach vollständiger Anmeldung mit Merk-Gerät kein Geheimnis im Klartext', async () => {
    const { service, data, secret } = await buildLogin();

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

    expect(data.audit.map((line) => line.action)).toEqual(
      expect.arrayContaining([
        'login.second_factor_required',
        'login.totp.success',
        'device.created',
      ]),
    );

    const everything = JSON.stringify(data.audit);
    expect(everything).not.toContain(TEST_PASSWORD);
    expect(everything).not.toContain(data.user[0].passwordHash);
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain(step1.flowToken);
    expect(done.trustedToken).toBeDefined();
    expect(everything).not.toContain(done.trustedToken);
    for (const device of data.devices) {
      expect(everything).not.toContain(device.tokenHash);
    }
  });

  it('protokolliert die Code-Einlösung mit der Datensatz-ID statt mit dem Code', async () => {
    const { service, data, codes, user } = await buildLogin();
    const eight = await codes.generateNewCodes(user.id);

    const step1 = await service.passwordLogin(
      'sam',
      TEST_PASSWORD,
      undefined,
      SOURCE,
    );
    if (step1.kind !== 'second-factor') throw new Error('unerwartet');
    await service.secondFactorRecoveryCode(
      step1.flowToken,
      eight[3],
      SOURCE,
    );

    const entry = data.audit.find(
      (line) => line.action === 'login.recovery_code.success',
    );
    expect(entry?.objectType).toBe('RecoveryCode');
    expect(data.codes.map((line) => line.id)).toContain(entry?.objectId);
    expect(entry?.beforeValue).toEqual({ consumed: false });
    expect(entry?.afterValue).toEqual({
      consumed: true,
      remainingOpen: 7,
    });

    const everything = JSON.stringify(data.audit);
    for (const code of eight) {
      expect(everything).not.toContain(code);
      expect(everything).not.toContain(code.replace('-', ''));
    }
  });
});

describe('Personenbezogene Felder im Audit-Log ([W4])', () => {
  it('entfernt jeden Wert, den die Kontaktdatenlöschung räumt', () => {
    // Sonst überlebten die Kontaktdaten die Löschung im Nachweis, der bewusst
    // keinen Löschweg hat — und die zugesagte Löschung wäre eine Behauptung.
    const before = Object.fromEntries(
      ContactFields.map((field) => [field, `wert-von-${field}`]),
    );

    const sanitized = sanitizeForAudit(before) as Record<string, unknown>;

    const leaked = ContactFields.filter(
      (field) => sanitized[field] !== REMOVED,
    );
    expect(leaked).toEqual([]);
  });

  it('behält die Feldnamen — die Tatsache der Änderung bleibt (R6)', () => {
    const sanitized = sanitizeForAudit({
      contactName: 'Anna Berg',
      status: 'demo',
    }) as Record<string, unknown>;

    expect(Object.keys(sanitized).sort()).toEqual([
      'contactName',
      'status',
    ]);
    // Der Status ist keine Person und bleibt lesbar.
    expect(sanitized['status']).toBe('demo');
    expect(sanitized['contactName']).toBe(REMOVED);
  });
});
