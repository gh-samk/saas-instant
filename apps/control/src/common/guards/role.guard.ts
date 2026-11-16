import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRED_ROLE } from '../decorators/require-role.decorator';
import { ForbiddenRoleError } from '../errors/business-error';
import type { LoggedInRequest } from './session.guard';

/**
 * Prüft die Rolle des angemeldeten Kontos gegen `@RequireAdmin()`.
 *
 * Läuft NACH dem `SessionGuard`, der `req.accessRole` aus der Sitzung setzt.
 * Ohne Markierung lässt der Guard alles durch — er verengt nur.
 */
@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRED_ROLE,
      [context.getHandler(), context.getClass()],
    );
    if (required === undefined) return true;

    const req = context.switchToHttp().getRequest<LoggedInRequest>();
    if (!req.user) {
      // Falsch verdrahtet (SessionGuard fehlt oder steht dahinter) — und zwar
      // so, dass die Route UNGEPRÜFT wäre. Lieber laut abbrechen.
      throw new Error(
        'RoleGuard ohne vorangehenden SessionGuard — Route falsch verdrahtet.',
      );
    }
    if (req.accessRole !== 'admin') {
      throw new ForbiddenRoleError();
    }
    return true;
  }
}
