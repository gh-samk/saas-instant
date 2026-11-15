import { HttpStatus } from '@nestjs/common';
import { BusinessError } from '../common/errors/business-error';

/** Es gibt keine Notiz mit dieser Kennung. */
export class NoteNotFoundError extends BusinessError {
  constructor() {
    super(
      'note_not_found',
      'Diese Notiz gibt es nicht (mehr).',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Systemerzeugte Notizen sind der Verlauf und kein Kommentarfeld.
 *
 * Serverseitige Regel, keine Höflichkeit der Oberfläche: ließe sich der
 * Wortlaut eines Statuswechsels nachträglich ändern oder entfernen, wäre der
 * Verlauf als Nachweis wertlos. Der Weg zum Kommentar ist eine eigene,
 * selbst erfasste Notiz.
 */
export class NoteBySystemError extends BusinessError {
  constructor() {
    super(
      'note_by_system',
      'Diese Notiz hat das System erzeugt. Sie lässt sich weder ändern noch ' +
        'löschen.',
      HttpStatus.CONFLICT,
    );
  }
}
