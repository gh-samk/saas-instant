import type { ConfigService } from '@nestjs/config';
import type { CookieOptions } from 'express';

/**
 * Lebensdauer des Sitzungs-Cookies: 30 Tage.
 *
 * Die Sitzung erneuert sich bei Nutzung selbst (siehe
 * SITZUNG_ERNEUERUNG_AB_MS), ein täglich benutztes Gerät bleibt also dauerhaft
 * angemeldet. Tragfähig ist das nur, weil `sitzungsGeneration` jederzeit ALLE
 * Sitzungen entwerten kann: Passwortwechsel, Passkey-Änderung und „alle
 * abmelden" wirken sofort, egal wie oft ein Token schon erneuert wurde.
 */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Ab welchem Alter ein Sitzungs-Token bei Nutzung durch ein frisches ersetzt
 * wird: ein Tag.
 *
 * Bewusst NICHT bei jedem Request. Jede Erneuerung kostet eine Signatur, eine
 * Datenbankabfrage (Generation) und einen Audit-Eintrag; bei einer Oberfläche,
 * die pro Seitenaufruf mehrere Anfragen stellt, wäre das reine Last ohne
 * Gewinn. Einmal täglich reicht, um die 30 Tage rollend zu halten.
 */
/**
 * Absolute Obergrenze einer Sitzung, auch bei laufender Erneuerung: nach 90
 * Tagen ist eine neue Anmeldung nötig.
 */
export const SESSION_ABSOLUTE_MAX_MS = 90 * 24 * 60 * 60 * 1000;
export const SESSION_RENEWAL_AFTER_MS = 24 * 60 * 60 * 1000;
/** Lebensdauer eines Merk-Geräts: 30 Tage, bei jeder Nutzung erneuert. */
export const TRUSTED_DEVICE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Ein angefangener Anmeldevorgang läuft nach 10 Minuten ab — dieselbe Frist wie
 * beim ausstehenden 2FA-Schritt der Kundenanwendung
 * (`pending2faCookieOptionen` in apps/api).
 */
export const LOGIN_MAX_AGE_MS = 10 * 60 * 1000;

/** Name des httpOnly-Sitzungs-Cookies. */
export const COOKIE_SESSION = 'session';
/** Name des Cookies für den laufenden, noch nicht abgeschlossenen Anmeldevorgang. */
export const COOKIE_LOGIN = 'login';
/** Name des Cookies für ein wiedererkanntes Merk-Gerät. */
export const COOKIE_TRUSTED_DEVICE = 'trusted_device';
/** Name des lesbaren CSRF-Cookies (Double-Submit). */
export const COOKIE_CSRF = 'csrf';

/**
 * Secure-Flag aus der Umgebung. `Secure` verlangt HTTPS – lokal per
 * COOKIE_SECURE=0 abschaltbar, sonst schlägt die Anmeldung über http fehl.
 */
function isSecure(config: ConfigService): boolean {
  return config.get<string>('COOKIE_SECURE', '1') !== '0';
}

/**
 * Sitzungs-Cookie. `SameSite=Strict` (nicht Lax wie in der Kundenanwendung):
 * die Verwaltung wird nie aus einer fremden Seite heraus verlinkt aufgerufen,
 * daher ist die strengere Einstellung ohne Komforteinbuße möglich.
 */
export function sessionCookieOptions(config: ConfigService): CookieOptions {
  return {
    httpOnly: true,
    secure: isSecure(config),
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_MAX_AGE_MS,
  };
}

/** Kurzlebiges httpOnly-Cookie für einen laufenden Anmeldevorgang (10 Minuten). */
export function loginCookieOptions(config: ConfigService): CookieOptions {
  return {
    httpOnly: true,
    secure: isSecure(config),
    sameSite: 'strict',
    path: '/',
    maxAge: LOGIN_MAX_AGE_MS,
  };
}

/** Langlebiges httpOnly-Cookie des Merk-Geräts (30 Tage, Rotation bei Nutzung). */
export function trustedDeviceCookieOptions(config: ConfigService): CookieOptions {
  return {
    httpOnly: true,
    secure: isSecure(config),
    sameSite: 'strict',
    path: '/',
    maxAge: TRUSTED_DEVICE_MAX_AGE_MS,
  };
}

/**
 * CSRF-Cookie. NICHT httpOnly, damit das Frontend den Wert lesen und als
 * Header `x-csrf-token` zurücksenden kann.
 */
export function csrfCookieOptions(config: ConfigService): CookieOptions {
  return {
    httpOnly: false,
    secure: isSecure(config),
    sameSite: 'strict',
    path: '/',
  };
}
