import type { CookieOptions, Request, Response } from 'express';
import type { PortalConfig } from '../config';

/** Cookie-Namen; mit Secure gilt das `__Host-`-Präfix (Pfad /, kein Domain-Attribut). */
export function cookieNames(config: PortalConfig) {
  const prefix = config.cookieSecure ? '__Host-' : '';
  return {
    session: `${prefix}portal_sid`,
    csrf: `${prefix}portal_csrf`,
    challenge: `${prefix}portal_wa`,
  };
}

export function sessionCookieOptions(config: PortalConfig, maxAgeMs: number): CookieOptions {
  return { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/', maxAge: maxAgeMs };
}

export function csrfCookieOptions(config: PortalConfig): CookieOptions {
  // Für die Oberfläche lesbar (Double-Submit), bewusst nicht HttpOnly.
  return { httpOnly: false, secure: config.cookieSecure, sameSite: 'lax', path: '/' };
}

export function readCookie(req: Request, name: string): string | undefined {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' && value ? value : undefined;
}

export function clearCookie(res: Response, config: PortalConfig, name: string): void {
  res.clearCookie(name, { path: '/', secure: config.cookieSecure, sameSite: 'lax' });
}

export function clientIp(req: Request): string {
  return req.ip ?? '';
}
