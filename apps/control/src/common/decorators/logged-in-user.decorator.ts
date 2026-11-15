import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { SessionUser } from '../../auth/session.service';
import type { LoggedInRequest } from '../guards/session.guard';

/** Liefert den vom SitzungGuard aufgelösten Benutzer. */
export const LoggedInUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SessionUser => {
    const req = ctx.switchToHttp().getRequest<LoggedInRequest>();
    if (!req.user) {
      // Kann nur auftreten, wenn der Dekorator ohne SitzungGuard verwendet wird.
      throw new Error(
        'AngemeldeterBenutzer ohne SitzungGuard verwendet — Route falsch verdrahtet.',
      );
    }
    return req.user;
  },
);
