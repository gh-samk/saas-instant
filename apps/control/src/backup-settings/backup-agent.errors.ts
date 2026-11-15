import { HttpStatus } from '@nestjs/common';
import { BusinessError } from '../common/errors/business-error';

/** Der Sicherungs-Agent ist in dieser Installation nicht eingerichtet. */
export class BackupAgentNotConfiguredError extends BusinessError {
  constructor() {
    super(
      'backup_agent_not_configured',
      'Der Sicherungs-Agent ist nicht eingerichtet (BACKUP_AGENT_SECRET fehlt oder ist zu kurz).',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

/**
 * Der Sicherungs-Agent antwortet nicht (nicht erreichbar, Zeitüberschreitung).
 * Kein stilles Scheitern: die Anfrage endet mit 503 und klarem Text.
 */
export class BackupAgentUnavailableError extends BusinessError {
  constructor() {
    super(
      'backup_agent_unavailable',
      'Der Sicherungs-Agent ist nicht erreichbar. Es wurde nichts verändert; bitte prüfen, ob der Container „backup-agent" läuft.',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

/** Der Agent hat die Anfrage abgelehnt oder unbrauchbar beantwortet. */
export class BackupAgentRejectedError extends BusinessError {
  constructor(agentStatus: number, message: string | null) {
    super(
      'backup_agent_rejected',
      message !== null && message !== ''
        ? `Der Sicherungs-Agent hat die Anfrage abgelehnt: ${message}`
        : 'Der Sicherungs-Agent hat die Anfrage abgelehnt.',
      HttpStatus.BAD_GATEWAY,
      { agentStatus },
    );
  }
}

/** Für diese Software ist kein Sicherungsplan im Manifest hinterlegt. */
export class BackupNotDeclaredError extends BusinessError {
  constructor() {
    super(
      'backup_not_declared',
      'Im Manifest fehlt der Abschnitt provisioning.backup. Ohne ihn weiß der Sicherungs-Agent nicht, wo die Daten einer Instanz liegen.',
      HttpStatus.CONFLICT,
    );
  }
}
