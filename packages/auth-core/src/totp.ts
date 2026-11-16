import { authenticator } from 'otplib';

/** Länge eines TOTP-Codes. */
export const TOTP_DIGITS = 6;
/** Dauer eines Zeitschritts in Sekunden. */
export const TOTP_STEP_SECONDS = 30;

/**
 * Wie lange ein noch unbestätigtes Geheimnis gilt: 10 Minuten. Eine
 * Einrichtung dauert das Scannen eines QR-Codes und das Abtippen von sechs
 * Ziffern; wer länger braucht, startet neu. Ohne Frist bliebe ein
 * abgebrochener Dialog dauerhaft als Ratestrecke stehen.
 */
export const TOTP_PENDING_VALID_MS = 10 * 60 * 1000;

/**
 * Eigene Instanz statt der globalen: ein Zeitfenster Toleranz in beide
 * Richtungen (± 30 Sekunden) gleicht Uhrenabweichung zwischen Telefon und
 * Server aus, ohne dass der Import dieses Pakets fremde otplib-Nutzer
 * umkonfiguriert.
 */
const totp = authenticator.clone({ window: 1 });

/** Ergebnis der TOTP-Einrichtung — der Klartext ist nur hier sichtbar. */
export interface TotpSetup {
  secretBase32: string;
  otpauthUrl: string;
}

/** Neues Base32-Geheimnis. */
export function generateTotpSecret(): string {
  return totp.generateSecret();
}

/** otpauth-URL für den QR-Code. */
export function buildOtpauthUrl(
  account: string,
  issuer: string,
  secretBase32: string,
): string {
  return totp.keyuri(account, issuer, secretBase32);
}

/** Geheimnis plus otpauth-URL in einem Schritt. */
export function createTotpSetup(account: string, issuer: string): TotpSetup {
  const secretBase32 = generateTotpSecret();
  return {
    secretBase32,
    otpauthUrl: buildOtpauthUrl(account, issuer, secretBase32),
  };
}

/**
 * Bringt die Eingabe auf sechs Ziffern (Leerzeichen und Trenner fallen weg).
 * Liefert null, wenn nicht genau sechs Ziffern übrig bleiben.
 */
export function normalizeTotpCode(code: string): string | null {
  const cleaned = code.replace(/\D/g, '');
  return cleaned.length === TOTP_DIGITS ? cleaned : null;
}

/** Der Zeitschritt, in dem `now` liegt. */
export function totpStepAt(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/** Passt der Code zum Geheimnis (innerhalb des Zeitfensters)? */
export function checkTotpCode(secretBase32: string, code: string): boolean {
  const cleaned = normalizeTotpCode(code);
  if (cleaned === null) return false;
  return totp.check(cleaned, secretBase32);
}

/**
 * Prüft den Code und liefert den ZEITSCHRITT, in dem er gültig war — oder
 * null. Das ist die Grundlage des Replay-Schutzes: der Aufrufer speichert den
 * zuletzt akzeptierten Schritt und lässt nur einen größeren zu (atomar, z. B.
 * als bedingtes UPDATE), damit ein abgegriffener Code nicht erneut gilt.
 */
export function checkTotpStep(
  secretBase32: string,
  code: string,
  now: Date = new Date(),
): number | null {
  const cleaned = normalizeTotpCode(code);
  if (cleaned === null) return null;
  const delta = totp.checkDelta(cleaned, secretBase32);
  if (delta === null) return null;
  return totpStepAt(now) + delta;
}

/**
 * Ist der Schritt neuer als der zuletzt verbrauchte? (Reine Entscheidung; die
 * atomare Durchsetzung gehört in die Datenbank.)
 */
export function isNewerTotpStep(
  step: number,
  lastStep: number | null,
): boolean {
  return lastStep === null || lastStep < step;
}

/**
 * Ist die Frist eines vorläufigen Geheimnisses abgelaufen? Ein FEHLENDER
 * Zeitpunkt gilt als abgelaufen: im Zweifel verfallen lassen.
 */
export function isTotpPendingExpired(
  validUntil: Date | null,
  now: Date = new Date(),
): boolean {
  if (!validUntil) return true;
  return validUntil.getTime() <= now.getTime();
}

/** Ablaufzeitpunkt für ein jetzt angelegtes vorläufiges Geheimnis. */
export function totpPendingValidUntil(now: Date = new Date()): Date {
  return new Date(now.getTime() + TOTP_PENDING_VALID_MS);
}
