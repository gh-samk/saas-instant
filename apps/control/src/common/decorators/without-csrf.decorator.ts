import { SetMetadata } from '@nestjs/common';

/** Metadatenschlüssel der Ausnahme. */
export const WITHOUT_CSRF = 'withoutCsrf';

/**
 * Nimmt eine schreibende Route AUSDRÜCKLICH vom CSRF-Schutz aus — mit
 * Begründung, nach demselben Muster wie `@OhneZweitfaktor`.
 *
 * Es gibt genau einen zulässigen Grund: die Route wird NICHT aus dem Browser
 * einer angemeldeten Person aufgerufen, sondern von einem Server, der sich mit
 * einem eigenen Geheimnis ausweist. Das Double-Submit-Verfahren setzt ein
 * Cookie voraus; ein Server, der proxyt, hat keines.
 *
 * Die Beweislast bleibt umgedreht: ohne diese Markierung ist jede schreibende
 * Route geschützt. `csrf-ausnahmen.spec.ts` zählt die Ausnahmen auf und lässt
 * keine unbegründete zu.
 *
 * @param grund Warum diese Route ohne CSRF-Token auskommt UND was stattdessen
 *              schützt. Wird im Test geprüft.
 */
export const WithoutCsrf = (reason: string) => SetMetadata(WITHOUT_CSRF, reason);
