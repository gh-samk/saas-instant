import { SetMetadata } from '@nestjs/common';

/** Metadatenschlüssel der Ausnahme. */
export const WITHOUT_SECOND_FACTOR = 'withoutSecondFactor';

/**
 * Nimmt eine Route AUSDRÜCKLICH von der Nachweispflicht aus — mit Begründung.
 *
 * Die Beweislast ist bewusst umgedreht: `ZweitfaktorGuard` verlangt den
 * Nachweis STANDARDMÄSSIG, und nur wer hier eine Begründung hinschreibt, kommt
 * ohne aus. Vorher war es andersherum — die Pflicht wurde an jeder Route
 * einzeln nachgezogen, und jedes Mal blieb eine übrig: erst `passkey/start`,
 * dann `email-code/einrichten`, dann `faktorEntfernen` und `widerrufe`, dann
 * `totp/einrichten` und `wiederherstellungscodes`. Über die letzten beiden lief
 * eine vollständige Kontoübernahme mit einem 25 Stunden alten Cookie ([K4]).
 *
 * Wer künftig eine Route hinzufügt und nichts markiert, bekommt eine
 * geschützte Route — nicht eine offene. Vergessen ist damit sicher, nicht
 * gefährlich. `zugang-routen.spec.ts` zählt zusätzlich alle Routen auf und
 * verlangt für jede Ausnahme eine Begründung.
 *
 * @param grund Warum diese Route ohne Nachweis auskommt. Wird im Test geprüft.
 */
export const WithoutSecondFactor = (reason: string) =>
  SetMetadata(WITHOUT_SECOND_FACTOR, reason);
