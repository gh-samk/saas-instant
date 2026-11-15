import { HttpStatus } from '@nestjs/common';
import { BusinessError } from '../common/errors/business-error';

export class TemplateNotFoundError extends BusinessError {
  constructor() {
    super('vorlage_nicht_gefunden', 'Vorlage nicht gefunden.', HttpStatus.NOT_FOUND);
  }
}

/**
 * Eine Vorlage des Transaktionskanals lässt sich nicht als Rundmail
 * verschicken — und umgekehrt.
 *
 * R3 auf der Ebene der Redaktion: Der Kanal steht AN DER VORLAGE und ist nach
 * dem Anlegen nicht mehr änderbar. Wäre er es, liesse sich eine
 * Werbebotschaft nachträglich zur Transaktionsmail erklären und damit an
 * Leute schicken, die nie eingewilligt haben.
 */
export class TemplateWrongChannelError extends BusinessError {
  constructor(channel: string) {
    super(
      'vorlage_falscher_kanal',
      `Diese Vorlage gehört zum Kanal „${channel}" und kann hier nicht ` +
        'verwendet werden.',
      HttpStatus.CONFLICT,
    );
  }
}

/** Die Vorlage benutzt Platzhalter, die niemand füllen kann. */
export class UnknownPlaceholderError extends BusinessError {
  constructor(names: string[]) {
    super(
      'unknown_placeholders',
      `Unbekannte Platzhalter: ${names.map((n) => `{{${n}}}`).join(', ')}. ` +
        'Trage sie in die Platzhalterliste der Vorlage ein oder korrigiere ' +
        'die Schreibweise.',
      HttpStatus.UNPROCESSABLE_ENTITY,
      { placeholders: names },
    );
  }
}

/**
 * Nach dem Einsetzen blieb ein Platzhalter stehen. Es geht nichts hinaus.
 *
 * Lieber ein sichtbarer Fehler in der Redaktion als „Hallo {{name}}," in
 * tausend Postfächern.
 */
export class OpenPlaceholderError extends BusinessError {
  constructor(names: string[]) {
    super(
      'open_placeholders',
      `Für ${names.map((n) => `{{${n}}}`).join(', ')} gibt es bei mindestens ` +
        'einer Empfängerin keinen Wert. Es wurde nichts verschickt.',
      HttpStatus.CONFLICT,
      { placeholders: names },
    );
  }
}

/** Die Vorlage ist stillgelegt. */
export class TemplateNotActiveError extends BusinessError {
  constructor() {
    super(
      'vorlage_nicht_aktiv',
      'Diese Vorlage ist stillgelegt und kann nicht verschickt werden.',
      HttpStatus.CONFLICT,
    );
  }
}

/** Es gibt niemanden mit bestätigter Einwilligung. */
export class NoRecipientError extends BusinessError {
  constructor() {
    super(
      'keine_empfaenger',
      'Es gibt derzeit keine Adresse mit bestätigter Einwilligung. Es wurde ' +
        'nichts eingestellt.',
      HttpStatus.CONFLICT,
    );
  }
}

/** Das angemeldete Konto hat keine hinterlegte E-Mail-Adresse. */
export class TestSendWithoutAddressError extends BusinessError {
  constructor() {
    super(
      'testversand_ohne_adresse',
      'Für dein Konto ist keine E-Mail-Adresse hinterlegt; ein Testversand ' +
        'geht ausschliesslich an die eigene Adresse.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Der Rumpf der Vorlage ist nach dem Säubern zu kurz oder zu lang.
 *
 * GEPRÜFT WIRD DIE ABGELEITETE TEXTFASSUNG, nicht das rohe HTML. Sonst
 * scheiterte ein kurzer, stark formatierter Absatz am Markup statt am
 * Wortumfang — und umgekehrt käme ein Rumpf durch, der nur aus leeren
 * Auszeichnungen besteht.
 *
 * Die Meldung nennt die gemessene Länge: Eine Grenze, die man nicht sehen
 * kann, ist beim Redigieren eine Schikane.
 */
export class TemplateContentError extends BusinessError {
  constructor(length: number, min: number, max: number) {
    super(
      'vorlage_inhalt_ungueltig',
      length < min
        ? `Der Text der Vorlage ist zu kurz (${length} Zeichen, mindestens ` +
            `${min}). Formatierungen zählen dabei nicht mit.`
        : `Der Text der Vorlage ist zu lang (${length} Zeichen, höchstens ` +
            `${max}). Formatierungen zählen dabei nicht mit.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
      { length, min, max },
    );
  }
}
