import { HttpStatus } from '@nestjs/common';
import { BusinessError } from '../common/errors/business-error';

/** Zu dieser Organisation gibt es (noch) keine Instanz. */
export class InstanceNotFoundError extends BusinessError {
  constructor() {
    super(
      'instance_not_found',
      'Zu dieser Organisation gibt es keine Instanz.',
      HttpStatus.NOT_FOUND,
    );
  }
}

/** Die Organisation hat bereits eine Instanz. Höchstens eine ist erlaubt. */
export class InstanceExistsAlreadyError extends BusinessError {
  constructor(subdomain: string) {
    super(
      'instance_exists_already',
      `Für diese Organisation läuft bereits eine Instanz (${subdomain}).`,
      HttpStatus.CONFLICT,
      { subdomain },
    );
  }
}

/**
 * Die Subdomain ist unzulässig geschrieben oder für den Betrieb reserviert.
 */

/**
 * Die Subdomain ist unzulässig geschrieben oder für den Betrieb reserviert.
 */
export class SubdomainInvalidError extends BusinessError {
  constructor(reason: string) {
    super('subdomain_invalid', reason, HttpStatus.BAD_REQUEST);
  }
}

/**
 * Die Subdomain ist schon vergeben — im CRM oder in Coolify.
 *
 * DAS IST DER FEHLER, DER DEN STILLEN DATENVERLUST VERHINDERT. Eine falsch
 * getippte Subdomain, die auf eine bestehende Anwendung zeigt, würde bei
 * voller Automatik deren Deployment überschreiben. Deshalb wird hier
 * abgebrochen, bevor irgendetwas passiert — und zwar zweimal: einmal bei der
 * Verfügbarkeitsprüfung und noch einmal unmittelbar vor dem Anlegen, weil
 * zwischen beiden Zeit vergeht.
 */
export class SubdomainTakenError extends BusinessError {
  constructor(subdomain: string) {
    super(
      'subdomain_taken',
      `„${subdomain}" ist bereits vergeben. Wähle eine andere Subdomain.`,
      HttpStatus.CONFLICT,
      { subdomain },
    );
  }
}

/**
 * Es liegt keine gültige, unverbrauchte Vorschau vor.
 *
 * DIE PFLICHT-VORSCHAU IST SERVERSEITIG ERZWUNGEN (E3-9). Ohne diesen Fehler
 * wäre sie eine Höflichkeit der Oberfläche: Wer den Anlege-Endpunkt direkt
 * aufruft, umginge sie. Genau deshalb liegt die Vorschau als Zeile in der
 * Datenbank und wird beim Anlegen atomar verbraucht.
 */
export class PreviewMissingError extends BusinessError {
  constructor() {
    super(
      'preview_missing',
      'Vor dem Anlegen muss die Vorschau erzeugt und bestätigt werden. ' +
        'Erzeuge sie erneut — sie gilt 15 Minuten.',
      HttpStatus.CONFLICT,
    );
  }
}

/** Die Instanz ist im falschen Zustand für diese Handlung. */
export class InstanceStatusMismatchError extends BusinessError {
  constructor(isStatus: string, expected: string) {
    super(
      'instance_status_mismatch',
      'Die Instanz ist dafür im falschen Zustand.',
      HttpStatus.CONFLICT,
      { isStatus, expected },
    );
  }
}

/** Der Schlüssel des Sicherungswerkzeugs fehlt oder stimmt nicht. */
export class BackupRejectedError extends BusinessError {
  constructor() {
    super('backup_rejected', 'Meldung abgewiesen.', HttpStatus.UNAUTHORIZED);
  }
}

/**
 * Eine Sicherung wird für einen Tag gemeldet, der noch nicht vorbei ist.
 *
 * ZWEITE VERTEIDIGUNGSLINIE hinter dem DTO-Validator ([K3]). Sie ist die
 * Mühe wert, weil die Folge UNUMKEHRBAR ist: Eine Zeile mit Datum in der
 * Zukunft schaltet die Aufgabe „Sicherung überfällig" für diese Instanz
 * dauerhaft ab, und einen Löschpfad für `Sicherung` gibt es bewusst nicht.
 */
export class BackupDateInFutureError extends BusinessError {
  constructor(date: string) {
    super(
      'backup_date_in_future',
      'Eine Sicherung kann nicht für einen Tag gemeldet werden, der noch ' +
        'nicht vorbei ist. Prüfe die Uhr des meldenden Systems.',
      HttpStatus.BAD_REQUEST,
      { date },
    );
  }
}

/**
 * Die Erstellung lässt sich nicht verwerfen, weil in Coolify schon etwas steht.
 *
 * Verworfen werden darf ausschliesslich ein Versuch, der GAR NICHT ERST
 * ANGEKOMMEN ist. Sobald eine Anwendung existiert, wäre das Aufgeben der
 * CRM-Zeile das Erzeugen einer Waise — und die Waise wäre danach nur noch über
 * den Abgleich auffindbar.
 */
export class DiscardNotPossibleError extends BusinessError {
  constructor(reason: string) {
    super('discard_not_possible', reason, HttpStatus.CONFLICT);
  }
}

/**
 * Für neue Instanzen fehlen die Versanddaten.
 *
 * Ohne sie käme eine Instanz hoch, die weder Einladungen noch Passwort-Links
 * verschickt — Coolify hätte `SMTP_HOST` aus der Pflichtform der Compose mit
 * einem deutschen Satz belegt (gemessen am 11.09.2026). Deshalb wird
 * abgelehnt, BEVOR eine Zeile oder eine Anwendung entsteht.
 */
export class InstanceSendMissingError extends BusinessError {
  constructor() {
    super(
      'instance_send_missing',
      'Für neue Instanzen sind keine Versanddaten hinterlegt ' +
        '(CONTROL_INSTANCE_SMTP_HOST und CONTROL_INSTANCE_SMTP_FROM). Ohne sie ' +
        'könnte die Instanz weder Einladungen noch Passwort-Links verschicken.',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

/**
 * „Erneut prüfen" passt nicht zum Zustand der Instanz.
 *
 * Erlaubt nur, wenn sie ausgerollt ist, aber noch nicht geantwortet hat.
 * Während des Aufbaus liefe die Prüfung neben dem Aufbau her; nach einem
 * Fehlschlag gäbe es nichts, was antworten könnte.
 */
export class ReachabilityNotCheckableError extends BusinessError {
  constructor() {
    super(
      'reachability_not_checkable',
      '„Erneut prüfen" geht nur, solange die Instanz ausgerollt ist, aber ' +
        'noch nicht geantwortet hat.',
      HttpStatus.CONFLICT,
    );
  }
}
