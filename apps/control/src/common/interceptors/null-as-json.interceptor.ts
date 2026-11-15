import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * ===========================================================================
 * `null` IST EINE ANTWORT — UND MUSS ALS SOLCHE ÜBER DIE LEITUNG GEHEN
 * ===========================================================================
 *
 * Gibt ein Handler `null` zurück, sendet der Express-Adapter von NestJS einen
 * LEEREN Body: `Content-Length: 0`, kein `Content-Type`. Für einen Aufrufer,
 * der `await antwort.json()` schreibt, ist das keine leere Antwort, sondern
 * ein Syntaxfehler.
 *
 * GEMESSEN wurde es an `GET /companies/:id/instanz`: Jede
 * Organisationsseite ohne Instanz brach in der Oberfläche ab. Dort wird es
 * inzwischen abgefangen — aber das ist die falsche Seite. Eine Route, die
 * `application/json` verspricht, muss `null` senden und nicht nichts.
 *
 * ES SIND ZWEI ROUTEN MIT DIESEM MUSTER (`…/instanz` und
 * `/broadcast/nachweis`), und es werden mehr: „gibt es das gerade nicht?" ist
 * eine häufige Frage. Deshalb steht die Lösung hier und nicht zweimal in einem
 * Controller — `null-als-json.spec.ts` zählt die betroffenen Routen ab.
 *
 * WAS ER NICHT ANFASST:
 * - `undefined` — das ist der Rückgabewert eines Handlers mit `@Res()`, der
 *   selbst gesendet hat (die PDF-, XML- und die beiden HTML-Routen). Dort
 *   nachträglich zu schreiben, ergäbe „headers already sent".
 * - Alles andere. Objekte, Listen und Zeichenketten serialisiert Nest wie
 *   bisher.
 */
@Injectable()
export class NullAsJsonInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((value: unknown) => {
        // NUR `null`, ausdrücklich nicht `undefined`.
        if (value !== null) return value;
        const res = context.switchToHttp().getResponse<Response>();
        if (res.headersSent) return value;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        // Die vier Zeichen `null` sind gültiges JSON. Als Zeichenkette
        // zurückgegeben, schreibt Nest sie unverändert in den Body — mit dem
        // Kopf von oben ist das eine wohlgeformte JSON-Antwort.
        return 'null';
      }),
    );
  }
}
