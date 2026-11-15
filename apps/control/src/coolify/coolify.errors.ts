import { HttpStatus } from '@nestjs/common';
import { BusinessError } from '../common/errors/business-error';

/**
 * Die Coolify-Anbindung ist nicht eingerichtet (`COOLIFY_TOKEN` fehlt).
 *
 * BEWUSST EIN SICHTBARER FEHLER und keine stille Wirkungslosigkeit: Wer eine
 * Instanz anlegen will und nichts passiert, sucht den Fehler bei sich.
 */
export class CoolifyNotConfiguredError extends BusinessError {
  constructor() {
    super(
      'coolify_not_configured',
      'Die Coolify-Anbindung ist nicht eingerichtet. Ohne COOLIFY_TOKEN ' +
        'lassen sich Instanzen weder anlegen noch archivieren.',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
