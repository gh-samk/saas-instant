import { HttpStatus } from '@nestjs/common';
import { BusinessError } from '../common/errors/business-error';

/**
 * Der öffentliche Anfrageweg ist auf dieser Anwendung nicht eingerichtet.
 *
 * Dieselbe Bauweise wie in `apps/api`: ohne die nötige Umgebungsvariable
 * existiert der Endpunkt fachlich nicht. Bewusst 404 und nicht 500 — eine
 * nicht eingerichtete Schnittstelle ist kein Fehler der Anwendung.
 */
export class InquiryNotActiveError extends BusinessError {
  constructor() {
    super(
      'anfrage_nicht_aktiv',
      'Anfragen sind auf dieser Anwendung nicht eingerichtet.',
      HttpStatus.NOT_FOUND,
    );
  }
}

/** Falscher oder fehlender Schlüssel im Header. */
export class InquiryKeyError extends BusinessError {
  constructor() {
    super(
      'anfrage_schluessel_ungueltig',
      'Diese Anfrage ist nicht berechtigt.',
      HttpStatus.UNAUTHORIZED,
    );
  }
}
