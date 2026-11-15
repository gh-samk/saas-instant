/**
 * Klassen, die an mehreren Stellen gleich aussehen müssen. Alles davon setzt
 * sich ausschließlich aus Tokens und Tailwind-Utilities zusammen — kein
 * eigener Farb- oder Größenwert (R7).
 */

/**
 * Textschaltfläche („wie ein Link"), z. B. „Zurück zur Anmeldung".
 *
 * Bewusst dauerhaft unterstrichen statt nur beim Überfahren: Standen zwei
 * gleichrangige Sekundäraktionen nebeneinander, sah nur die gerade überfahrene
 * klickbar aus, die andere wirkte wie Fließtext (Finding DW3). Beide Aktionen
 * tragen deshalb dieselbe Klasse. Beim Überfahren wechselt nur die Farbe
 * (Token `primaer-hover`), die Unterstreichung bleibt — sonst entstünde beim
 * Zeigen wieder ein Unterschied zwischen den beiden.
 */
export const TEXT_BUTTON =
  'text-primaer underline underline-offset-2 hover:text-primaer-hover';

/**
 * Textschaltfläche, die eine EIGENSTÄNDIGE Handlung auslöst — nicht ein Link
 * im Fließtext.
 *
 * Gemessen bei 375 px im Browser: `TEXTKNOPF` allein ergibt eine 20 px hohe
 * Trefferfläche. Für einen Verweis mitten in einem Satz ist das richtig, dort
 * ist die Zeile das Ziel. Für „Entwurf löschen" oder „Vermerken" ist es
 * zu wenig — das sind Schaltflächen, die zufällig wie Text aussehen, und auf
 * einem Telefon trifft man sie schlecht.
 *
 * Die Lösung ändert nur die FLÄCHE, nicht das Aussehen: derselbe unterstrichene
 * Text, aber mit vertikalem Innenabstand auf 44 px Mindesthöhe gebracht. Die
 * optische Zurückhaltung — der Grund, warum hier kein `Knopf` steht — bleibt
 * damit erhalten. Werte aus der Tailwind-Skala, keine rohen Pixel (R7).
 */
export const TEXT_BUTTON_ACTION = `inline-flex min-h-11 items-center gap-1 py-2 ${TEXT_BUTTON}`;
