/**
 * Bewertung der Passwortstärke — eigene, absichtlich einfache Heuristik ohne
 * zusätzliche Abhängigkeit.
 *
 * Vorgabe des Betreibers: **mindestens 12 Zeichen, sonst keine
 * Zusammensetzungsregeln.** Die Stärkeanzeige ist deshalb ein Hinweis und kein
 * Zwang: sie beeinflusst nur die Darstellung, nie die Absendbarkeit. Was
 * darüber entscheidet, ob ein Passwort angenommen wird, ist ausschließlich
 * `passwortIstZulaessig` — dieselbe Grenze, die auch der Server prüft
 * (`NotfallPasswortDto`, `@MinLength(12)`).
 */

/** Mindestlänge eines Passworts. Muss zur Serverregel passen. */
export const MIN_LENGTH_PASSWORD = 12;

/** 0 = leer, 1 = schwach, 2 = mittel, 3 = stark. */
export type PasswordStrength = 0 | 1 | 2 | 3;

/** Zählt, wie viele Zeichenklassen vorkommen (klein, groß, Ziffer, sonstiges). */
function characterClasses(password: string): number {
  let count = 0;
  if (/[a-zäöüß]/.test(password)) count += 1;
  if (/[A-ZÄÖÜ]/.test(password)) count += 1;
  if (/[0-9]/.test(password)) count += 1;
  if (/[^a-zA-ZäöüÄÖÜß0-9]/.test(password)) count += 1;
  return count;
}

/**
 * Erfüllt das Passwort die harte Mindestanforderung?
 * Einzige Bedingung: Länge. Keine erzwungene Zeichenmischung.
 */
export function passwordIsAllowed(password: string): boolean {
  return password.length >= MIN_LENGTH_PASSWORD;
}

/**
 * Stufe für die Anzeige.
 *
 * Länge wiegt schwerer als Zeichenvielfalt, weil eine lange Passphrase in der
 * Praxis stärker ist als ein kurzes Passwort mit Sonderzeichen. Unterhalb der
 * Mindestlänge ist die Stufe immer 1 — die Anzeige soll dort nicht durch drei
 * gefüllte Segmente in falscher Sicherheit wiegen.
 */
export function passwordStrength(password: string): PasswordStrength {
  if (password.length === 0) return 0;
  if (!passwordIsAllowed(password)) return 1;

  let points = 1;
  if (password.length >= 16) points += 1;
  if (password.length >= 20) points += 1;
  if (characterClasses(password) >= 3) points += 1;
  return (points > 3 ? 3 : points) as PasswordStrength;
}

/**
 * Sind neues Passwort und Wiederholung zusammen absendbar?
 * Genau die Bedingung, gegen die beide Passwortformulare ihren Knopf sperren.
 */
export function newPasswordValid(
  newValue: string,
  repeat: string,
): boolean {
  return passwordIsAllowed(newValue) && repeat.length > 0 && newValue === repeat;
}
