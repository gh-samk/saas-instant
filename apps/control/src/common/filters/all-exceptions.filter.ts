import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * Globaler Exception-Filter. Antwortet immer im einheitlichen Fehlerformat
 * `{ "fehler": { "code", "nachricht", "detail"? } }`.
 *
 * Kein Silent Failure: unerwartete Fehler werden mit Stacktrace geloggt und
 * dem Aufrufer als 500 gemeldet — sie verschwinden nie unbemerkt.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'internal_error';
    let message = 'Ein unerwarteter Fehler ist aufgetreten.';
    let detail: unknown = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exResponse = exception.getResponse();
      code = `HTTP_${status}`;
      if (typeof exResponse === 'string') {
        message = exResponse;
      } else if (typeof exResponse === 'object' && exResponse !== null) {
        const res = exResponse as Record<string, unknown>;
        // Fachlicher Fehler: eigener, stabiler Code statt HTTP_<status>.
        if (typeof res['errorCode'] === 'string') code = res['errorCode'];
        if (typeof res['message'] === 'string') {
          message = res['message'];
        } else if (Array.isArray(res['message']) && res['message'].length > 0) {
          // ValidationPipe liefert eine Liste von Meldungen. Die erste wird zur
          // sichtbaren Nachricht — sonst stünde dort „unerwarteter Fehler",
          // obwohl der Grund bekannt ist.
          const messages = res['message'] as unknown[];
          message = String(messages[0]);
          detail = messages;
        }
        if (res['detail'] !== undefined) detail = res['detail'];
        if (res['errors'] !== undefined) detail = res['errors'];
      }
    } else if (exception instanceof Error) {
      this.logger.error(exception.message, exception.stack);
    } else {
      this.logger.error(`Unbekannter Fehlerwert: ${String(exception)}`);
    }

    response.status(status).json({
      error: {
        code,
        message,
        ...(detail !== undefined ? { detail } : {}),
      },
    });
  }
}
