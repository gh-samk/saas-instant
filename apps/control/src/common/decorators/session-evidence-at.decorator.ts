import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { LoggedInRequest } from '../guards/session.guard';

/**
 * Liefert den NACHWEISZEITPUNKT der laufenden Sitzung aus dem SIGNIERTEN Token
 * (`auth_time`): wann sich der Benutzer zuletzt wirklich ausgewiesen hat.
 *
 * BEWUSST NICHT der Ausstellungszeitpunkt des Tokens (`iat`). Der wandert bei
 * jeder Erneuerung nach vorn; das Frische-Fenster daran zu hängen hiesse, es
 * mit jedem Seitenaufruf zurückzusetzen ([K1]).
 *
 * `null`, wenn das Token keinen Nachweiszeitpunkt trägt — dann gilt die Sitzung
 * als nicht frisch. Nur zusammen mit dem SitzungGuard verwendbar.
 */
export const SessionEvidenceAt = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Date | null => {
    const req = ctx.switchToHttp().getRequest<LoggedInRequest>();
    if (req.user === undefined) {
      throw new Error(
        'SitzungNachweisAm ohne SitzungGuard verwendet — Route falsch verdrahtet.',
      );
    }
    return req.sessionEvidenceAt ?? null;
  },
);
