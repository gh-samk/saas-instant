import { HttpStatus } from '@nestjs/common';
import { BusinessError } from '../common/errors/business-error';

/** Der eingetippte Instanzname stimmt nicht mit der Instanz überein. */
export class RestoreConfirmationError extends BusinessError {
  constructor() {
    super(
      'restore_confirmation_mismatch',
      'Der eingetippte Instanzname stimmt nicht mit der Instanz überein. Es wurde nichts gestartet.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/** Diese Sicherung gibt es an dieser Instanz nicht. */
export class BackupNotFoundError extends BusinessError {
  constructor() {
    super('backup_not_found', 'Diese Sicherung gibt es für die Instanz nicht.', HttpStatus.NOT_FOUND);
  }
}

/** Die Sicherung ist nicht wiederherstellbar (kein Objekt im Ziel gemeldet). */
export class BackupNotRestorableError extends BusinessError {
  constructor() {
    super(
      'backup_not_restorable',
      'Zu dieser Sicherung sind kein Objekt und keine Prüfsumme im Sicherungsziel gemeldet; sie lässt sich nicht automatisch wiederherstellen.',
      HttpStatus.CONFLICT,
    );
  }
}

/** Für die Instanz läuft schon eine Wiederherstellung. */
export class RestoreInProgressError extends BusinessError {
  constructor() {
    super(
      'restore_in_progress',
      'Für diese Instanz läuft bereits eine Wiederherstellung.',
      HttpStatus.CONFLICT,
    );
  }
}

/** Die Wiederherstellung gibt es nicht. */
export class RestoreNotFoundError extends BusinessError {
  constructor() {
    super('restore_not_found', 'Diese Wiederherstellung gibt es nicht.', HttpStatus.NOT_FOUND);
  }
}

/** Die Wiederherstellung ist nicht im Zustand „bereit zur Übernahme". */
export class RestoreNotAdoptableError extends BusinessError {
  constructor(reason: string) {
    super('restore_not_adoptable', reason, HttpStatus.CONFLICT);
  }
}

/** Die alte Instanz ließ sich nicht stoppen; es wurde nichts umgestellt. */
export class AdoptStopFailedError extends BusinessError {
  constructor() {
    super(
      'adopt_stop_failed',
      'Die alte Instanz ließ sich nicht stoppen. Es wurde nichts umgestellt und nichts gelöscht.',
      HttpStatus.BAD_GATEWAY,
    );
  }
}

/** Die Geheimnisse der Instanz sind nicht lesbar; ohne sie startet die neue nicht. */
export class RestoreTokensMissingError extends BusinessError {
  constructor() {
    super(
      'restore_tokens_missing',
      'Die gespeicherten Instanz-Geheimnisse sind nicht lesbar (CONTROL_CONFIG_KEY getauscht?). Es wurde nichts angelegt.',
      HttpStatus.CONFLICT,
    );
  }
}

/** Der Sicherungsplan der Instanz ist unvollständig (z. B. Anwendungs-ID fehlt). */
export class BackupPlanIncompleteError extends BusinessError {
  constructor() {
    super(
      'backup_plan_incomplete',
      'Der Compose-Projektname der Instanz lässt sich nicht bestimmen (Coolify-Anwendung nicht hinterlegt?).',
      HttpStatus.CONFLICT,
    );
  }
}
