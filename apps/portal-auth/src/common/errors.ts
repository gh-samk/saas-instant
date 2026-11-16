import { HttpException } from '@nestjs/common';

/** Fachlicher Fehler: stabiler Code (`error`) plus lesbare Meldung (Deutsch). */
export class ApiError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super({ error: code, message, ...extra }, status);
  }
}

export const invalidCredentials = () =>
  new ApiError(401, 'invalid_credentials', 'Anmeldung nicht möglich. Bitte Eingaben prüfen.');
export const unauthenticated = () => new ApiError(401, 'unauthenticated', 'Bitte anmelden.');
export const forbidden = (message = 'Dafür fehlt die Berechtigung.') =>
  new ApiError(403, 'forbidden', message);
export const notFound = (what = 'Nicht gefunden.') => new ApiError(404, 'not_found', what);
export const badRequest = (code: string, message: string) => new ApiError(400, code, message);
