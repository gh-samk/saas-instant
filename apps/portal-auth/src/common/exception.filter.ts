import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';

/** Einheitliches Fehlerformat `{ error, message }`; unerwartete Fehler werden geloggt. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Fehler');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null && 'error' in body) {
        response.status(status).json(body);
        return;
      }
      const message = typeof body === 'string' ? body : (body as { message?: unknown }).message;
      const first = Array.isArray(message) ? String(message[0]) : message ? String(message) : 'Fehler';
      response.status(status).json({
        error: status === 400 ? 'invalid_request' : status === 404 ? 'not_found' : `http_${status}`,
        message: first,
      });
      return;
    }
    this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    response.status(500).json({ error: 'internal_error', message: 'Ein unerwarteter Fehler ist aufgetreten.' });
  }
}
