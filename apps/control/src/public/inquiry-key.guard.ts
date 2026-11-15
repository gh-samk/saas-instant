import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import { sourceFrom } from '../common/inquiry-source';
import {
  InquiryNotActiveError,
  InquiryKeyError,
} from './public.errors';
import { KEY_HEADER, keyMatches } from './key';

/**
 * Der einzige Schutz des einzigen unauthentifizierten SCHREIBWEGES.
 *
 * Der Schlüssel steht in `CONTROL_INQUIRY_KEY` und wird vom nginx der
 * Webseite gesetzt — NICHT im Browser. Ein Formular, das den Schlüssel selbst
 * mitschickte, gäbe ihn jedem Besucher preis; deshalb geht der Weg über den
 * Proxy, der ihn serverseitig anhängt.
 *
 * Ist die Variable nicht gesetzt, existiert die Route fachlich nicht (404) —
 * dieselbe Bauweise wie `ANFRAGE_EMPFAENGER` in `apps/api`. So ist der Weg auf
 * einer Anwendung, die ihn nicht braucht, auch nicht versehentlich offen.
 *
 * Jeder abgewiesene Versuch wird protokolliert. Ohne Audit-Eintrag ließe sich
 * der Schlüssel unbemerkt durchprobieren; das globale Rate-Limit allein sieht
 * niemand.
 */
@Injectable()
export class InquiryKeyGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const expected = (
      this.config.get<string>('CONTROL_INQUIRY_KEY') ?? ''
    ).trim();
    if (expected === '') throw new InquiryNotActiveError();

    const req = context.switchToHttp().getRequest<Request>();
    const included = req.headers[KEY_HEADER];
    // Ein doppelt gesetzter Header kommt als Feld an. Nichts davon ist ein
    // gültiger Schlüssel — geprüft wird trotzdem denselben Weg entlang.
    const value = Array.isArray(included) ? undefined : included;

    if (!keyMatches(value, expected)) {
      await this.audit.log({
        userId: null,
        actor: 'form',
        action: AUDIT_ACTION.publicInquiryRefused,
        objectType: 'Inquiry',
        objectId: null,
        afterValue: { reason: 'schluessel_ungueltig' },
        ...sourceFrom(req),
      });
      throw new InquiryKeyError();
    }
    return true;
  }
}
