import { authenticator } from 'otplib';
import { describe, expect, it } from 'vitest';
import {
  buildOtpauthUrl,
  checkTotpCode,
  checkTotpStep,
  createTotpSetup,
  generateTotpSecret,
  isNewerTotpStep,
  isTotpPendingExpired,
  normalizeTotpCode,
  TOTP_PENDING_VALID_MS,
  totpPendingValidUntil,
  totpStepAt,
} from './totp';

describe('totp', () => {
  it('erzeugt ein Geheimnis und eine otpauth-URL', () => {
    const setup = createTotpSetup('a@example.com', 'Verwaltung');
    expect(setup.secretBase32).toMatch(/^[A-Z2-7]+$/);
    expect(setup.otpauthUrl.startsWith('otpauth://totp/')).toBe(true);
    expect(setup.otpauthUrl).toContain(`secret=${setup.secretBase32}`);
    expect(buildOtpauthUrl('a@example.com', 'V', setup.secretBase32)).toContain(
      'issuer=V',
    );
  });

  it('normalisiert die Eingabe auf sechs Ziffern', () => {
    expect(normalizeTotpCode('123 456')).toBe('123456');
    expect(normalizeTotpCode('12345')).toBeNull();
    expect(normalizeTotpCode('1234567')).toBeNull();
  });

  it('akzeptiert den aktuellen Code und die Nachbarschritte, nicht mehr', () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const current = authenticator.generate(secret);
    expect(checkTotpCode(secret, current)).toBe(true);
    expect(checkTotpCode(secret, current.replace(/(\d)/, (d) => String((+d + 1) % 10)))).toBe(
      false,
    );
    const farAway = authenticator.clone({ epoch: now + 5 * 60 * 1000 }).generate(secret);
    expect(checkTotpCode(secret, farAway)).toBe(false);
    expect(checkTotpCode(secret, '12')).toBe(false);
  });

  it('liefert den Zeitschritt des Codes (Replay-Schutz-Grundlage)', () => {
    const secret = generateTotpSecret();
    const now = new Date();
    const code = authenticator.generate(secret);
    const step = checkTotpStep(secret, code, now);
    expect(step).not.toBeNull();
    expect(Math.abs((step as number) - totpStepAt(now))).toBeLessThanOrEqual(1);
    expect(checkTotpStep(secret, '000000x', now)).toBeNull();
  });

  it('entscheidet über neuere Schritte', () => {
    expect(isNewerTotpStep(10, null)).toBe(true);
    expect(isNewerTotpStep(10, 9)).toBe(true);
    expect(isNewerTotpStep(10, 10)).toBe(false);
    expect(isNewerTotpStep(10, 11)).toBe(false);
  });

  it('Frist des vorläufigen Geheimnisses', () => {
    const now = new Date('2026-01-01T10:00:00Z');
    const until = totpPendingValidUntil(now);
    expect(until.getTime() - now.getTime()).toBe(TOTP_PENDING_VALID_MS);
    expect(isTotpPendingExpired(until, now)).toBe(false);
    expect(isTotpPendingExpired(until, until)).toBe(true);
    expect(isTotpPendingExpired(null, now)).toBe(true);
  });
});
