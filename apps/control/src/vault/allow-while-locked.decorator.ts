import { SetMetadata } from '@nestjs/common';

/** Metadatenschlüssel der Ausnahme von der Tresor-Sperre. */
export const ALLOW_WHILE_LOCKED = 'vault:allowWhileLocked';

/**
 * Lässt eine Route (oder einen ganzen Controller) AUCH BEI GESPERRTEM TRESOR
 * durch — mit Begründung, nach dem Muster von `@WithoutCsrf`.
 *
 * Die Entscheidung hängt am Handler, nicht an der URL: Nest führt den Guard erst
 * aus, wenn eine Route gefunden wurde, und gefunden wird sie nach den Regeln von
 * Express (ohne Beachtung der Groß-/Kleinschreibung, auch bei absoluter
 * Anfrage-URL). Eine Pfadprüfung im Guard sieht dieselbe Anfrage anders als das
 * Routing und ließ sich damit umgehen (`/API/companies`).
 *
 * Es gibt genau einen zulässigen Grund: die Route liest und schreibt nachweislich
 * KEINE verschlüsselten Felder (`ENCRYPTED_FIELDS`) und braucht den Datenschlüssel
 * nicht. Ohne diese Markierung antwortet jede Route bei gesperrtem Tresor mit 423.
 *
 * @param reason Warum die Route ohne Schlüssel auskommt. Wird im Test geprüft.
 */
export const AllowWhileLocked = (reason: string) =>
  SetMetadata(ALLOW_WHILE_LOCKED, reason);

/** Metadatenschlüssel der Ausnahme, die nur gilt, solange noch kein Tresor eingerichtet ist. */
export const ALLOW_WHILE_UNINITIALIZED = 'vault:allowWhileUninitialized';

/**
 * Wie `AllowWhileLocked`, aber NUR solange es noch keinen Tresor gibt (frische
 * Installation). Für die Ersteinrichtung des ersten Kontos, die vor der
 * Tresor-Einrichtung läuft. Ist der Tresor eingerichtet und gesperrt, antwortet
 * die Route wieder mit 423.
 */
export const AllowWhileUninitialized = (reason: string) =>
  SetMetadata(ALLOW_WHILE_UNINITIALIZED, reason);
