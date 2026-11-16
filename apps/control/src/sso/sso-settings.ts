import type { ConfigService } from '@nestjs/config';

/**
 * Betriebsart der Anmeldung.
 *
 * - `single`: die Verwaltung meldet selbst an (Passwort, zweiter Faktor,
 *   Passkey). Das war immer so und bleibt der Standard.
 * - `portal`: die Anmeldung kommt vom Portal (OIDC Authorization Code + PKCE).
 *   Lokal anmelden dürfen sich dann nur Konten mit Notzugang.
 */
export type AuthMode = 'single' | 'portal';

/** Einstellungen des SSO-Clients, aus der Umgebung gelesen und geprüft. */
export interface SsoSettings {
  mode: AuthMode;
  /** Öffentliche Basis-URL des Portals = erwartetes `iss`, ohne Schrägstrich am Ende. */
  issuer: string;
  /** Interne Basis für Token-Abruf und JWKS (Standard: der Aussteller). */
  internalUrl: string;
  /** Kennung dieser Verwaltung beim Portal (= Slug) = erwartetes `aud`. */
  clientId: string;
  clientSecret: string;
  /** Ziel nach dem Portal-Logout; muss beim Portal registriert sein. */
  postLogoutUrl: string;
  /** Mindestabstand zwischen zwei Abrufen des JWKS bei unbekannter `kid` (ms). */
  jwksCooldownMs: number;
}

/** Leser für Umgebungswerte; `ConfigService.get` passt, ein Test übergibt ein Objekt. */
export type EnvReader = (key: string) => string | undefined;

/** Adapter für den ConfigService. */
export function envFrom(config: ConfigService): EnvReader {
  return (key) => config.get<string>(key);
}

function trimmed(value: string | undefined): string {
  return (value ?? '').trim();
}

/** Liest AUTH_MODE. Leer = `single`; alles außer `single`/`portal` bricht ab. */
export function authModeFrom(read: EnvReader): AuthMode {
  const raw = trimmed(read('AUTH_MODE')).toLowerCase();
  if (raw === '' || raw === 'single') return 'single';
  if (raw === 'portal') return 'portal';
  throw new Error(
    `AUTH_MODE muss "single" oder "portal" sein, war "${raw}".`,
  );
}

function asUrl(name: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} ist keine gültige Adresse: "${value}".`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${name} muss mit http:// oder https:// beginnen.`);
  }
  return value.replace(/\/+$/, '');
}

/**
 * Liest und prüft die SSO-Umgebung.
 *
 * Im Modus `portal` MÜSSEN PORTAL_ISSUER, PORTAL_CLIENT_ID und
 * PORTAL_CLIENT_SECRET gesetzt sein — sonst bricht der Start ab, statt erst
 * beim ersten Anmeldeversuch aufzufallen. Im Modus `single` wird nichts
 * davon gelesen.
 */
export function readSsoSettings(read: EnvReader): SsoSettings {
  const mode = authModeFrom(read);
  if (mode === 'single') {
    return {
      mode,
      issuer: '',
      internalUrl: '',
      clientId: '',
      clientSecret: '',
      postLogoutUrl: '',
      jwksCooldownMs: 30_000,
    };
  }
  const missing = ['PORTAL_ISSUER', 'PORTAL_CLIENT_ID', 'PORTAL_CLIENT_SECRET']
    .filter((name) => trimmed(read(name)) === '');
  if (missing.length > 0) {
    throw new Error(
      `AUTH_MODE=portal verlangt ${missing.join(', ')}. Die Verwaltung startet ohne diese Angaben nicht.`,
    );
  }
  const issuer = asUrl('PORTAL_ISSUER', trimmed(read('PORTAL_ISSUER')));
  const internalRaw = trimmed(read('PORTAL_INTERNAL_URL'));
  const appUrl = trimmed(read('CONTROL_APP_URL')) || 'http://localhost:8080';
  const postLogoutRaw = trimmed(read('PORTAL_POST_LOGOUT_URI'));
  const cooldownRaw = trimmed(read('PORTAL_JWKS_COOLDOWN_MS'));
  const cooldown = cooldownRaw === '' ? 30_000 : Number(cooldownRaw);
  if (!Number.isInteger(cooldown) || cooldown < 0) {
    throw new Error(
      `PORTAL_JWKS_COOLDOWN_MS muss eine ganze Zahl >= 0 sein, war "${cooldownRaw}".`,
    );
  }
  return {
    mode,
    issuer,
    internalUrl:
      internalRaw === '' ? issuer : asUrl('PORTAL_INTERNAL_URL', internalRaw),
    clientId: trimmed(read('PORTAL_CLIENT_ID')),
    clientSecret: trimmed(read('PORTAL_CLIENT_SECRET')),
    postLogoutUrl:
      postLogoutRaw === ''
        ? `${appUrl.replace(/\/+$/, '')}/`
        : asUrl('PORTAL_POST_LOGOUT_URI', postLogoutRaw),
    jwksCooldownMs: cooldown,
  };
}

/** Die Adresse des Portal-Logouts, zu der die Oberfläche nach dem Abmelden navigiert. */
export function portalLogoutUrl(settings: SsoSettings): string {
  const url = new URL(`${settings.issuer}/oauth/logout`);
  url.searchParams.set('client_id', settings.clientId);
  url.searchParams.set('post_logout_redirect_uri', settings.postLogoutUrl);
  return url.toString();
}

/** Bequem für Aufrufer, die nur wissen wollen, ob das Portal führt. */
export function isPortalMode(config: ConfigService): boolean {
  return authModeFrom(envFrom(config)) === 'portal';
}
