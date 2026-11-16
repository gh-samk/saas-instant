import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { sameConstantTime } from '@saas-instant/auth-core';
import type { Request } from 'express';
import { WITHOUT_CSRF } from '../decorators/without-csrf.decorator';

const PROTECTED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF-Schutz nach dem Double-Submit-Verfahren.
 *
 * Bei schreibenden Requests (POST/PUT/PATCH/DELETE) muss der Header
 * `x-csrf-token` exakt dem Cookie `csrf` entsprechen — zeitkonstant verglichen.
 * Zusammen mit SameSite=Strict am Sitzungs-Cookie ergibt das doppelten Schutz.
 *
 * Global registriert; GET/HEAD/OPTIONS (inkl. GET /api/auth/csrf) sind ausgenommen.
 *
 * Einzelne Routen können sich mit `@OhneCsrf('<Begründung>')` ausnehmen. Das
 * ist NUR für Aufrufer gedacht, die gar keinen Browser haben und sich
 * stattdessen mit einem eigenen Geheimnis ausweisen — der Server-zu-Server-Weg
 * der öffentlichen Anfrage. `csrf-ausnahmen.spec.ts` zählt sie auf.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!PROTECTED_METHODS.has(req.method)) {
      return true;
    }

    const exception = this.reflector.get<string | undefined>(
      WITHOUT_CSRF,
      context.getHandler(),
    );
    if (exception) return true;

    const cookieToken = req.cookies?.['csrf'] as string | undefined;
    const headerToken = req.headers['x-csrf-token'] as string | undefined;

    if (
      !cookieToken ||
      !headerToken ||
      !sameConstantTime(cookieToken, headerToken)
    ) {
      throw new ForbiddenException('CSRF-Token fehlt oder ungültig.');
    }
    return true;
  }
}
