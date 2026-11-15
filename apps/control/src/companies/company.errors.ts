import { HttpStatus } from '@nestjs/common';
import { BusinessError } from '../common/errors/business-error';

/** Es gibt keine Organisation mit dieser Kennung. */
export class CompanyNotFoundError extends BusinessError {
  constructor() {
    super(
      'company_not_found',
      'Diese Organisation gibt es nicht (mehr).',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Der gewünschte Status steht schon da — oder jemand anderes war schneller.
 *
 * Beides ist derselbe Befund und wird bewusst nicht unterschieden: Der
 * Schreibvorgang ist bedingt, und die Bedingung traf nicht zu. Die Oberfläche
 * lädt daraufhin neu und zeigt den tatsächlichen Stand.
 */
export class StatusUnchangedError extends BusinessError {
  constructor(isStatus: string) {
    super(
      'status_unchanged',
      'Der Status wurde nicht geändert — er steht bereits so oder wurde ' +
        'zwischenzeitlich von anderer Stelle geändert.',
      HttpStatus.CONFLICT,
      { isStatus },
    );
  }
}

/**
 * Die Bestätigung stimmt nicht mit dem Namen der Organisation überein.
 *
 * Die Löschung der Kontaktdaten ist unumkehrbar. Ein Fehlgriff in einer Liste
 * soll dafür nicht genügen — deshalb muss der Name abgetippt werden.
 */
export class ConfirmationMatchesNotError extends BusinessError {
  constructor() {
    super(
      'confirmation_matches_not',
      'Zur Bestätigung muss der Name der Organisation genau eingegeben werden.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * ===========================================================================
 * MONATLICH GEHT NUR PER LASTSCHRIFT
 * ===========================================================================
 *
 * Die Zusage steht in den Zahlungsbedingungen des Produkts: „Halbjährlich und jährlich per
 * Überweisung oder Lastschrift, monatlich per Lastschrift. Zwölf einzelne
 * Überweisungen im Jahr sind für beide Seiten Aufwand ohne Gegenwert."
 *
 * GEPRÜFT WIRD SERVERSEITIG, nicht nur im Formular. Die Regel verbindet zwei
 * Felder — Rhythmus und Art —, und ein Validierungsdekorator sieht immer nur
 * eines. Sie im Formular zu prüfen hiesse, sie halb zu prüfen: Ein zweites
 * Fenster, ein direkter Aufruf oder ein späterer Umbau der Oberfläche käme
 * daran vorbei.
 *
 * SIE GILT IN BEIDE RICHTUNGEN. Wer auf `monatlich` umstellt, während
 * `ueberweisung` eingetragen ist, bekommt denselben Fehler wie umgekehrt —
 * sonst liesse sich die Regel über die Reihenfolge zweier Änderungen
 * umgehen.
 */
export class MonthlyOnlyDirectDebitError extends BusinessError {
  constructor() {
    super(
      'monthly_only_direct_debit',
      'Monatliche Zahlung ist nur per Lastschrift möglich. Zwölf einzelne ' +
        'Überweisungen im Jahr sind für beide Seiten Aufwand ohne Gegenwert — ' +
        'für Überweisung bitte auf halbjährlich oder jährlich stellen.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/** Warum eine Organisation nicht gelöscht werden kann. */
export type DeletionBlocker =
  | 'instance'
  | 'invoices'
  | 'marketingMails';

/**
 * ===========================================================================
 * DIE ORGANISATION TRÄGT ETWAS, DAS BLEIBEN MUSS
 * ===========================================================================
 *
 * Das Löschen einer Organisation ist der EINZIGE Weg in diesem System, auf
 * dem ein Stammdatensatz verschwindet. Es gibt ihn, weil sich sonst jede
 * Testanfrage für immer im Register sammelt — und ein Register, in dem
 * niemand mehr die echten von den verworfenen unterscheidet, ist keines.
 *
 * DREI DINGE VERHINDERN IHN, und alle drei aus demselben Grund: Sie sind
 * Belege, die eine gelöschte Organisation nicht mehr erklären könnte.
 *
 * - `instance`: Es gab (oder gibt) ein Deployment. Nach R1 wird eine Instanz
 *   nie gelöscht, auch nicht archiviert — sie bliebe als Zeile ohne
 *   Organisation zurück.
 * - `invoices`: Nach R2 ist eine Rechnung unveränderlich, auch ein Entwurf
 *   trägt bereits einen Empfängerschnappschuss. Wer einen Entwurf loswerden
 *   will, hat dafür den eigenen Weg (`DELETE …/entwurf`).
 * - `marketingMails`: Der Nachweis, dass eine WERBLICHE Mail unter einer
 *   bestimmten Einwilligung hinausging (R3). Transaktionsmails — die
 *   Bestätigung einer Anfrage, die Demo-Zugangsdaten — zählen ausdrücklich
 *   NICHT dazu: Sie entstehen bei jeder Anfrage, und würden sie hindern,
 *   wäre genau der Fall nicht löschbar, für den es diesen Weg gibt.
 *
 * DIE MELDUNG NENNT ALLE HINDERNISSE AUF EINMAL, nicht das erste. Wer drei
 * Anläufe braucht, um zu erfahren, was alles im Weg steht, hört nach dem
 * zweiten auf.
 */
export class CompanyNotDeletableError extends BusinessError {
  constructor(blockers: DeletionBlocker[]) {
    const texts: Record<DeletionBlocker, string> = {
      instance:
        'Für diese Organisation wurde eine Instanz eingerichtet. Instanzen ' +
        'werden nie gelöscht (R1) — die Organisation bleibt deshalb bestehen.',
      invoices:
        'Zu dieser Organisation gibt es Rechnungen. Rechnungen sind ' +
        'unveränderlich (R2); ein reiner Entwurf lässt sich vorher einzeln ' +
        'verwerfen.',
      marketingMails:
        'An diese Organisation ging eine werbliche Rundmail. Der Nachweis ' +
        'dazu muss bestehen bleiben (R3).',
    };
    super(
      'company_not_deletable',
      `Diese Organisation lässt sich nicht löschen. ${blockers
        .map((h) => texts[h])
        .join(' ')}`,
      HttpStatus.CONFLICT,
      { blockers },
    );
  }
}
