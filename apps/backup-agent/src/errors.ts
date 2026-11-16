/** Auftrag bewusst verschoben (kein Fehler): wird beim naechsten Planlauf erneut versucht. */
export class DeferredError extends Error {
  readonly deferred = true;
}

/** Die Verwaltung antwortet 423: Tresor gesperrt, Klartext ist (noch) nicht abrufbar. */
export class ControlLockedError extends DeferredError {
  constructor() {
    super('Verwaltung ist gesperrt (Tresor nicht entsperrt), Rechnungsarchiv wird beim naechsten Lauf erneut versucht');
  }
}
