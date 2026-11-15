/**
 * PLATZHALTER IN EINER VORLAGE — die Anzeigeseite derselben Regel.
 *
 * Das Muster ist wörtlich dasselbe wie in `src/broadcast/platzhalter.ts`:
 * `{{name}}`, zwei geschweifte Klammern, kein Leerraum, nur Kleinbuchstaben
 * und Unterstrich. Alles andere ist kein Platzhalter, sondern Text.
 *
 * WARUM DAS HIER NOCH EINMAL STEHT, obwohl der Server dieselbe Prüfung macht:
 * Der Server prüft beim Speichern und antwortet dann mit
 * `unbekannte_platzhalter`. Das ist die verbindliche Prüfung und bleibt es.
 * Diese Fassung beantwortet eine andere Frage, und zwar WÄHREND jemand
 * schreibt: „Welche Platzhalter stehen gerade in meinem Text, und ist einer
 * davon nirgends erklärt?" Eine Vorlage geht an alle gleichzeitig; ein
 * Tippfehler soll auffallen, solange der Text noch im Feld steht.
 *
 * MASSGEBLICH BLEIBT DER SERVER. Weicht diese Fassung ab, lehnt er das
 * Speichern mit seiner eigenen Meldung ab, und die wird angezeigt — dieselbe
 * Aufteilung wie bei `SPERRGRUND_TEXTE` und `FESTSCHREIBEN_BESTAETIGUNG`.
 */

const PATTERN = /\{\{([a-z_]+)\}\}/g;

/** Alle im Text vorkommenden Platzhalter, ohne Dubletten, in Fundreihenfolge. */
export function foundPlaceholders(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(PATTERN)) {
    const name = match[1];
    if (name !== undefined && !found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * Platzhalter, die im Text stehen, aber nirgends erklärt sind.
 *
 * `erlaubt` sind die selbstdeklarierten Namen; die beiden Standardplatzhalter
 * kommen vom Aufrufer dazu — die Liste hier trifft keine eigene Entscheidung
 * darüber, was der Server ohnehin füllen kann.
 */
export function unknownPlaceholders(
  text: string,
  allowed: readonly string[],
): string[] {
  const allowedSet = new Set(allowed);
  return foundPlaceholders(text).filter((name) => !allowedSet.has(name));
}

/**
 * Zerlegt die Eingabe des Platzhalterfeldes in eine Liste von Namen.
 *
 * Getrennt wird an Komma UND Leerraum, weil beides erwartbar getippt wird.
 * Geschweifte Klammern werden entfernt: Wer die Liste aus dem Text
 * herüberkopiert, tippt „{{name}}" — und ein Name mit Klammern scheitert am
 * `@Matches(/^[a-z_]{1,40}$/)` des Servers, ohne dass klar wäre, warum.
 */
export function placeholdersFromInput(value: string): string[] {
  const names = value
    .replace(/[{}]/g, ' ')
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
  return [...new Set(names)];
}
