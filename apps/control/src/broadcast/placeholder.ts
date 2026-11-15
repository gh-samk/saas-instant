import { escapeContent } from '../mail/layout';

/**
 * PLATZHALTER IN VORLAGEN — und die Regel, die sie erst benutzbar macht.
 *
 * Geschrieben wird `{{organisation}}`. Zwei geschweifte Klammern, kein
 * Leerraum, nur Kleinbuchstaben und Unterstrich; alles andere ist keiner.
 * Die enge Form ist Absicht: Ein Wortlaut, der an tausend Postfächer geht,
 * darf nicht davon abhängen, ob jemand ein Leerzeichen gesetzt hat.
 *
 * DIE WICHTIGE REGEL STEHT IN `offenePlatzhalter`: Bleibt nach dem Einsetzen
 * ein Platzhalter stehen, geht die Mail NICHT hinaus. „Hallo {{name}}," ist
 * kein kleiner Schönheitsfehler, sondern die sichtbarste Art zu zeigen, dass
 * ein Versand nicht geprüft wurde — und sie geht an alle gleichzeitig.
 */

/** Platzhalter, die der Versand immer füllen kann. */
export const DEFAULT_PLACEHOLDER = ['organisation', 'abmeldelink'] as const;

const PATTERN = /\{\{([a-z_]+)\}\}/g;

/** Alle im Text vorkommenden Platzhalter, ohne Dubletten, in Fundreihenfolge. */
export function foundPlaceholder(text: string): string[] {
  const found: string[] = [];
  for (const hit of text.matchAll(PATTERN)) {
    const name = hit[1];
    if (name && !found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * Platzhalter, die in der Vorlage stehen, aber nirgends erklärt sind.
 *
 * Wird beim SPEICHERN geprüft, nicht erst beim Versand: Ein Tippfehler in
 * einer Vorlage soll auffallen, während jemand sie schreibt, und nicht, wenn
 * sie schon unterwegs ist.
 */
export function unknownPlaceholder(
  text: string,
  allowed: readonly string[],
): string[] {
  const permissible = new Set<string>([...DEFAULT_PLACEHOLDER, ...allowed]);
  return foundPlaceholder(text).filter((name) => !permissible.has(name));
}

/** Setzt die bekannten Werte ein. Unbekannte Platzhalter bleiben stehen. */
export function replace(text: string, values: Record<string, string>): string {
  return text.replace(PATTERN, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name]! : whole,
  );
}

/**
 * Was nach dem Einsetzen übrig blieb. Ist die Liste nicht leer, darf die Mail
 * nicht hinausgehen.
 */
export function openPlaceholder(text: string): string[] {
  return foundPlaceholder(text);
}

/**
 * Setzt die Werte in ein HTML-FRAGMENT ein — und escaped sie dabei.
 *
 * DER GRUND IST NICHT KOSMETISCH. `{{organisation}}` wird durch einen Namen
 * aus der Datenbank ersetzt. Steht dort „Müller & Söhne", ergäbe ein rohes
 * Einsetzen ein kaputtes `&`; stünde dort eine Zeichenkette mit spitzen
 * Klammern, ergäbe es Markup, das der Säuberer nie gesehen hat. Der Säuberer
 * prüft die VORLAGE, nicht die eingesetzten Werte — die kommen später und aus
 * einer anderen Quelle.
 *
 * Der Textteil braucht das nicht: dort ist ein `<` ein `<`.
 */
export function replaceInHtml(
  html: string,
  values: Record<string, string>,
): string {
  const escaped = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, escapeContent(value)]),
  );
  return replace(html, escaped);
}
