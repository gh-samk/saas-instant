/**
 * Dichte-Rezept für Tabellen und Karten (Design-Spezifikation, Abschnitt 8).
 *
 * Bewusst nur Konstanten, keine neue Prop an `Tabelle` oder `Karte`: die
 * Komponenten aus `@saas-instant/ui` bleiben unverändert (R7). Die Kopfzeile von
 * `Tabelle` ist dort fest auf `px-4 py-2.5` verdrahtet und bleibt es.
 *
 * Die Verwaltung ist ein operatives Werkzeug und deshalb durchgehend dichter
 * als `apps/web`. Die „standard"-Variante aus Abschnitt 8 der Spezifikation ist
 * hier bewusst NICHT übernommen: sie stützt sich auf zwei willkürliche
 * Pixel-Schriftgrößen aus `apps/web`, und rohe Größenwerte sind in
 * `apps/control` ausgeschlossen (R7, AK6). Gebraucht wird sie in Etappe 1 an
 * keiner Stelle.
 */

/** Zeilen-Innenabstand für Tabellenzellen (<td>). */
export const tableRow = {
  compact: 'px-4 py-2',
} as const;

/** Text-Hierarchie innerhalb einer Zelle (Primär-/Sekundärzeile). */
export const tableText = {
  compact: {
    primary: 'text-sm font-medium text-text',
    secondary: 'text-xs text-leise',
  },
} as const;

/** Innenabstand für `Karte` (die Komponente bringt selbst keinen mit). */
export const cardPadding = {
  standard: 'p-6',
  compact: 'p-4',
} as const;
