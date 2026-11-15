import {
  ArgumentMetadata,
  HttpStatus,
  Injectable,
  PipeTransform,
} from '@nestjs/common';
import { BusinessError } from '../errors/business-error';

/**
 * Ein Text enthaelt ein Steuerzeichen, das dort nicht hingehoert.
 *
 * Bewusst ein fachlicher Fehler mit 400 und nicht der fruehere
 * `500 interner_fehler`: Eine Eingabe, die die Anwendung nicht annehmen kann,
 * ist ein Fehler des Absenders und kein Ausfall des Servers ([W8]).
 */
export class ControlCharsError extends BusinessError {
  constructor(field: string) {
    super(
      'control_chars_in_text',
      'Der Text enthaelt Steuerzeichen, die nicht zulaessig sind.',
      HttpStatus.BAD_REQUEST,
      { field },
    );
  }
}

/**
 * Steuerzeichen ausser Zeilenumbruch und Tabulator. Insbesondere das NUL-Byte.
 *
 * Ein NUL-Byte bricht in PostgreSQL jeden `text`-Wert ab; der Treiber meldet
 * einen Fehler, und die Anfrage endete mit `500 interner_fehler`. Am einzigen
 * unauthentifizierten Schreibweg ist das der Unterschied zwischen "Eingabe
 * abgewiesen" und "Server kaputt" — und Letzteres verraet mehr, als es soll
 * ([W8]).
 */
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * Weist Steuerzeichen ab, BEVOR sie die Datenbankschicht erreichen.
 *
 * Global registriert und VOR der ValidationPipe: Die Pruefung gehoert an den
 * Rand der Anwendung und nicht in dreissig einzelne Feld-Dekoratoren, von
 * denen einer vergessen wird. Zeilenumbruch und Tabulator bleiben erlaubt —
 * eine mehrzeilige Nachricht ist zulaessige Eingabe. Was sie in einer Notiz
 * anrichten kann, verhindert `oeffentlich/fremdtext.ts`, nicht diese Pipe.
 */
@Injectable()
export class ControlCharsPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'body' && metadata.type !== 'query') return value;
    this.check(value, metadata.type, 0);
    return value;
  }

  private check(value: unknown, path: string, depth: number): void {
    if (depth > 8) return;
    if (typeof value === 'string') {
      if (FORBIDDEN.test(value)) throw new ControlCharsError(path);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, i) =>
        this.check(entry, `${path}[${i}]`, depth + 1),
      );
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const [field, content] of Object.entries(value)) {
        this.check(content, `${path}.${field}`, depth + 1);
      }
    }
  }
}
