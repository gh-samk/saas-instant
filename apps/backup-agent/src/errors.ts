/** Auftrag bewusst verschoben (kein Fehler): wird beim naechsten Planlauf erneut versucht. */
export class DeferredError extends Error {
  readonly deferred = true;
}

/** Die Verwaltung antwortet 423: Tresor gesperrt, Klartext ist (noch) nicht abrufbar. */
export class ControlLockedError extends DeferredError {
  constructor(message = 'Verwaltung ist gesperrt (Tresor nicht entsperrt), Rechnungsarchiv wird beim naechsten Lauf erneut versucht') {
    super(message);
  }
}

/** Die Verwaltung hat mit einem Fehlerstatus geantwortet (Text ohne Antwortinhalt, damit nichts durchsickert). */
export class ControlHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
