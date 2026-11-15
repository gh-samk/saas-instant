import { HttpStatus } from '@nestjs/common';
import { BusinessError } from '../common/errors/business-error';

/**
 * Der Bestätigungslink ist unbekannt oder verbraucht.
 *
 * BEWUSST DIESELBE ANTWORT für „kennen wir nicht" und „ist abgelaufen und
 * gelöscht" — nach 72 Stunden ist die Zeile weg, ein Unterschied lässt sich
 * also gar nicht mehr feststellen. Der Text sagt beides und nennt den Weg
 * zurück.
 */
export class ConfirmationUnknownError extends BusinessError {
  constructor() {
    super(
      'bestaetigung_unbekannt',
      'Dieser Bestätigungslink ist unbekannt oder älter als 72 Stunden. ' +
        'Trage dich bitte erneut ein.',
      HttpStatus.NOT_FOUND,
    );
  }
}

/** Der Abmeldelink ist unbekannt. */
export class UnsubscribeUnknownError extends BusinessError {
  constructor() {
    super(
      'abmeldung_unbekannt',
      'Dieser Abmeldelink ist unbekannt. Möglicherweise wurde die Adresse ' +
        'bereits ausgetragen.',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Für diese Adresse liegt KEINE bestätigte Einwilligung vor.
 *
 * Die Antwort auf jeden Versuch, den werblichen Kanal ohne Opt-in zu
 * benutzen — auch auf den bequemen: den Testversand an die eigene Adresse.
 * Es gibt keinen Schalter, der ihn übergeht (R3).
 */
export class NoMarketingApprovalError extends BusinessError {
  constructor(reason: string) {
    super(
      'keine_werbefreigabe',
      'Für diese Adresse liegt keine bestätigte Einwilligung vor; eine ' +
        'werbliche Mail kann sie deshalb nicht bekommen.',
      HttpStatus.CONFLICT,
      { reason },
    );
  }
}
