import { HttpStatus } from '@nestjs/common';
import { BusinessError } from '../common/errors/business-error';

/**
 * DAS LETZTE AKTIVE KONTO BLEIBT.
 *
 * Ohne diese Sperre liesse sich die Verwaltung in einen Zustand bringen, aus
 * dem niemand mehr herauskommt: kein Konto mit Zugang, also niemand, der ein
 * neues eintragen könnte. Der Weg zurück wäre der Notfall-Link über die
 * Kommandozeile — auf einem Server, an den im Zweifel niemand herankommt.
 *
 * GEPRÜFT WIRD SERVERSEITIG, in derselben Transaktion wie die Änderung. Ein
 * ausgegrauter Knopf in der Oberfläche ist Komfort; zwei gleichzeitige
 * Entzüge liefen daran vorbei.
 */
export class LastAccountError extends BusinessError {
  constructor() {
    super(
      'last_account',
      'Das ist das letzte Konto mit Zugang. Es lässt sich nicht abschalten — ' +
        'sonst käme niemand mehr in die Verwaltung.',
      HttpStatus.CONFLICT,
    );
  }
}

/** Das eigene Konto lässt sich nicht selbst entrechten oder abschalten. */
export class OwnAccountError extends BusinessError {
  constructor() {
    super(
      'own_account',
      'Das eigene Konto lässt sich hier nicht abschalten. Wer das täte, wäre ' +
        'ausgesperrt — und müsste jemand anderen bitten, es rückgängig zu ' +
        'machen.',
      HttpStatus.CONFLICT,
    );
  }
}

/** Zu dieser Adresse gibt es bereits ein Konto. */
export class AddressAlreadyTakenError extends BusinessError {
  constructor() {
    super(
      'address_already_taken',
      'Zu dieser E-Mail-Adresse gibt es bereits ein Konto.',
      HttpStatus.CONFLICT,
    );
  }
}

export class UserNotFoundError extends BusinessError {
  constructor() {
    super(
      'user_not_found',
      'Dieses Konto gibt es nicht.',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Ein neuer Zugangslink nur für ein Konto OHNE Zugang.
 *
 * Für ein Konto mit Passwort wäre das ein Passwort-Zurücksetzen durch die
 * Administration — ein anderer Vorgang mit anderen Folgen, und einer, den es
 * hier bewusst nicht gibt: Wer das Passwort einer anderen Person setzen kann,
 * kann in ihrem Namen handeln.
 */
export class AccountAlreadyHasAccessError extends BusinessError {
  constructor() {
    super(
      'account_already_has_access',
      'Dieses Konto hat bereits einen Zugang. Einen neuen Zugangslink gibt ' +
        'es nur für Konten, die noch keinen eingelöst haben.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Der Weg zum allerersten Konto steht nur einer LEEREN Verwaltung offen.
 *
 * Sobald ein Konto existiert, ist die Nutzerverwaltung der richtige Ort — und
 * für ein bestehendes Konto ohne Zugang `emergency enrollment <kennung>`.
 */
export class FirstAccountNotPossibleError extends BusinessError {
  constructor(reason: string) {
    super('first_account_not_possible', reason, HttpStatus.CONFLICT);
  }
}
