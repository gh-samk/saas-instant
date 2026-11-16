import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { sameConstantTime } from '@saas-instant/auth-core';
import { CONFIG, PortalConfig } from '../config';
import { SessionsService, SessionView } from '../sessions/sessions.service';
import { ApiError, forbidden, unauthenticated } from './errors';
import { cookieNames, readCookie } from './cookies';
import { RateLimiter } from './rate-limiter';

export const WITHOUT_CSRF = 'portal:withoutCsrf';
/**
 * Nimmt eine schreibende Route AUSDRÜCKLICH vom CSRF-Schutz aus, mit Begründung.
 * Zulässig nur für Server-zu-Server-Wege ohne Browser-Cookie (z. B. der
 * Token-Endpunkt von OIDC). Ohne Markierung ist jede schreibende Route geschützt.
 */
export const WithoutCsrf = (reason: string) => SetMetadata(WITHOUT_CSRF, reason);

/**
 * Double-Submit-CSRF für ALLE schreibenden Anfragen, dazu Origin-Prüfung.
 *
 * Die Entscheidung hängt an der gefundenen Route (`@WithoutCsrf`), nicht an der
 * URL: eine Pfadprüfung wie `startsWith('/api/')` sieht `/API/me/...` oder eine
 * absolute Anfrage-URL anders als das Express-Routing, das beides derselben
 * Route zuordnet, und ließ die Prüfung entfallen.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    @Inject(CONFIG) private readonly config: PortalConfig,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
    const exempt = this.reflector.getAllAndOverride<string | undefined>(WITHOUT_CSRF, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (typeof exempt === 'string' && exempt.length > 0) return true;
    const origin = req.headers.origin;
    if (origin && origin !== this.config.origin) {
      throw new ApiError(403, 'csrf_origin', 'Anfrage von fremder Herkunft abgelehnt.');
    }
    const cookie = readCookie(req, cookieNames(this.config).csrf);
    const header = req.headers['x-csrf-token'];
    if (!cookie || typeof header !== 'string' || !header || !sameConstantTime(cookie, header)) {
      throw new ApiError(403, 'csrf_invalid', 'Sicherheitsprüfung fehlgeschlagen. Seite neu laden.');
    }
    return true;
  }
}

export const RATE_LIMIT = 'rate-limit';
/** `@RateLimit('login', 20)` = höchstens 20 Aufrufe je Minute und Adresse. */
export const RateLimit = (bucket: string, perMinute: number) =>
  SetMetadata(RATE_LIMIT, { bucket, perMinute });

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiter,
    @Inject(CONFIG) private readonly config: PortalConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.config.rateLimitDisabled) return true;
    const meta = this.reflector.getAllAndOverride<{ bucket: string; perMinute: number }>(RATE_LIMIT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!meta) return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (!this.limiter.take(`${meta.bucket}:${req.ip ?? ''}`, meta.perMinute, 60_000)) {
      throw new ApiError(429, 'rate_limited', 'Zu viele Anfragen. Bitte kurz warten.');
    }
    return true;
  }
}

declare global {
  namespace Express {
    interface Request {
      portal?: SessionView;
    }
  }
}

/** Verlangt eine gültige Portal-Sitzung und legt sie an die Anfrage. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionsService,
    @Inject(CONFIG) private readonly config: PortalConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const token = readCookie(req, cookieNames(this.config).session);
    const view = token ? await this.sessions.resolve(token) : null;
    if (!view) throw unauthenticated();
    req.portal = view;
    return true;
  }
}

@Injectable()
export class PortalAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.portal?.account.portalAdmin) throw forbidden('Nur für Portal-Administratoren.');
    return true;
  }
}
