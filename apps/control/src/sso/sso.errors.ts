import { HttpStatus } from '@nestjs/common';
import { BusinessError } from '../common/errors/business-error';

/**
 * Der SSO-Durchlauf ist gescheitert (Signatur, state, nonce, Token-Abruf …).
 *
 * Nach außen IMMER dieselbe knappe Meldung: wer die Prüfung umgehen will, soll
 * aus der Antwort nichts lernen. Der Grund steht im Audit-Log.
 */
export class SsoInvalidError extends BusinessError {
  /**
   * Nur bei einem gescheiterten Step-up: der Pfad, zu dem es danach zurückgeht
   * (das Popup braucht ihn, um dem Öffner den Misserfolg zu melden).
   */
  stepUpReturn?: string;

  constructor(readonly reason: string) {
    super(
      'sso_invalid',
      'Die Anmeldung über das Portal ist fehlgeschlagen.',
      HttpStatus.UNAUTHORIZED,
    );
  }
}

/** Das Portal kennt das Konto, aber es hat keine Rolle in dieser Verwaltung. */
export class SsoNoAccessError extends BusinessError {
  constructor() {
    super(
      'no_access',
      'Kein Zugriff auf diese Verwaltung.',
      HttpStatus.FORBIDDEN,
    );
  }
}
