/**
 * Konfiguration aus der Umgebung. Fehlt etwas Wesentliches oder ist es zu
 * schwach, bricht der Start ab — lieber gar nicht laufen als unsicher.
 */
export const CONFIG = Symbol('PORTAL_CONFIG');

export interface PortalConfig {
  /** Öffentliche Basis-URL des Portals ohne Schrägstrich am Ende (= iss). */
  issuer: string;
  /** Origin des Portals (WebAuthn, Origin-Prüfung). */
  origin: string;
  /** Relying-Party-ID: Hostname des Portals. */
  rpId: string;
  rpName: string;
  /** Schlüsselmaterial für Signaturschlüssel und TOTP-Geheimnisse. */
  keySecret: string;
  /** Cookies mit `__Host-`-Präfix und Secure (Standard); nur lokal ohne TLS abschaltbar. */
  cookieSecure: boolean;
  /** Anzahl vorgeschalteter Reverse-Proxys (für die Client-Adresse). */
  trustProxy: number;
  totpIssuer: string;
  port: number;
  /** Nur für Tests: Ratenbegrenzung aus. */
  rateLimitDisabled: boolean;
}

export const MIN_KEY_SECRET_LENGTH = 32;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PortalConfig {
  const issuerRaw = (env.PORTAL_ISSUER ?? '').trim();
  if (!issuerRaw) throw new Error('PORTAL_ISSUER fehlt (öffentliche Basis-URL des Portals).');
  let url: URL;
  try {
    url = new URL(issuerRaw);
  } catch {
    throw new Error(`PORTAL_ISSUER ist keine gültige URL: "${issuerRaw}".`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('PORTAL_ISSUER muss mit http(s):// beginnen.');
  }
  const cookieSecure = (env.COOKIE_SECURE ?? 'true').trim().toLowerCase() !== 'false';
  if (cookieSecure && url.protocol !== 'https:') {
    throw new Error(
      'PORTAL_ISSUER muss https sein (oder COOKIE_SECURE=false nur für lokale Entwicklung setzen).',
    );
  }
  const keySecret = env.PORTAL_KEY_SECRET ?? '';
  if (keySecret.length < MIN_KEY_SECRET_LENGTH) {
    throw new Error(
      `PORTAL_KEY_SECRET fehlt oder ist zu kurz (mindestens ${MIN_KEY_SECRET_LENGTH} Zeichen).`,
    );
  }
  const proxyRaw = (env.PORTAL_TRUST_PROXY ?? '').trim();
  const trustProxy = proxyRaw === '' ? 0 : Number(proxyRaw);
  if (!Number.isInteger(trustProxy) || trustProxy < 0) {
    throw new Error(`PORTAL_TRUST_PROXY muss eine ganze Zahl >= 0 sein, war "${proxyRaw}".`);
  }
  const port = Number((env.PORTAL_AUTH_PORT ?? env.PORT ?? '3100').trim());
  if (!Number.isInteger(port) || port <= 0) throw new Error('PORT ist ungültig.');
  return {
    issuer: issuerRaw.replace(/\/+$/, ''),
    origin: url.origin,
    rpId: url.hostname,
    rpName: (env.PORTAL_NAME ?? 'Portal').trim() || 'Portal',
    keySecret,
    cookieSecure,
    trustProxy,
    totpIssuer: (env.PORTAL_TOTP_ISSUER ?? env.PORTAL_NAME ?? 'Portal').trim() || 'Portal',
    port,
    rateLimitDisabled: env.PORTAL_RATE_LIMIT_DISABLED === '1',
  };
}
