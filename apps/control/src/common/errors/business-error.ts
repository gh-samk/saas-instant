import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Fehler mit einem stabilen, fachlichen Code. Der globale Exception-Filter
 * übernimmt Code, Nachricht und Detail unverändert in das Antwortformat
 * `{ "fehler": { "code", "nachricht", "detail"? } }`.
 *
 * Anders als bei einer nackten HttpException (Code `HTTP_401`) kann das
 * Frontend gegen den Code programmieren, z. B. gegen `konto_gesperrt`.
 */
export class BusinessError extends HttpException {
  constructor(
    readonly errorCode: string,
    message: string,
    status: HttpStatus,
    readonly errorDetail?: unknown,
  ) {
    super({ errorCode, message: message, detail: errorDetail }, status);
  }
}

/**
 * Konto ist wegen zu vieler Fehlversuche gesperrt. Die Sperre endet von selbst.
 *
 * Bewusst RESTSEKUNDEN statt Zeitstempel: kein ISO-Datum, keine Abhängigkeit
 * von der Uhrzeit des Clients.
 */
export class AccountLockedError extends BusinessError {
  constructor(secondsRemaining: number) {
    super(
      'account_locked',
      'Zu viele Fehlversuche. Das Konto ist vorübergehend gesperrt.',
      HttpStatus.TOO_MANY_REQUESTS,
      { secondsRemaining },
    );
  }
}

/**
 * Sammelfehler für jeden gescheiterten Anmeldeversuch. Bewusst dieselbe
 * Meldung für „Konto unbekannt", „falscher Code" und „Code verbraucht" —
 * sonst verrät die Antwort, ob ein Konto existiert.
 */
export class LoginFailedError extends BusinessError {
  /**
   * `detail` bleibt optional und ist absichtlich eng: Es transportiert
   * ausschließlich den Grund eines Code-Fehlschlags („falsch", „verbrannt",
   * „abgelaufen", „kein_code"), damit die Oberfläche einen Tippfehler von
   * einem verbrannten Code unterscheiden kann. Das ist nur dort zulässig, wo
   * der Aufrufer das Passwort bereits bewiesen hat oder in einer gültigen
   * Sitzung sitzt — NIEMALS auf einer anonymen Route.
   */
  constructor(
    message = 'Anmeldung fehlgeschlagen.',
    detail?: { reason: string },
  ) {
    super('login_failed', message, HttpStatus.UNAUTHORIZED, detail);
  }
}

/**
 * Der letzte eingerichtete zweite Faktor lässt sich nicht entfernen.
 *
 * Serverseitige Regel, keine UI-Höflichkeit: ohne zweiten Faktor käme niemand
 * mehr über den Passwortweg herein, und ohne Passkey gar nicht mehr. Der
 * Ausweg wäre nur noch das Notfallkommando im Container.
 */
export class LastFactorError extends BusinessError {
  constructor(label: string) {
    super(
      'last_factor',
      `„${label}" ist der letzte eingerichtete zweite Faktor und lässt ` +
        'sich deshalb nicht entfernen. Richte zuerst einen anderen ein.',
      HttpStatus.CONFLICT,
    );
  }
}
