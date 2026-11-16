import type { ReactNode } from 'react';
import { useMediaQuery } from '../lib/use-media-query';

/**
 * Ab dieser Breite steht eine Liste als Tabelle, darunter als Karten.
 *
 * GEMESSEN, nicht geschätzt: Bei 1024 px bleiben neben der Seitenleiste 706 px
 * Inhalt — für die Spalten der Organisations-, Instanz- und Rechnungsliste zu
 * wenig. Ab 1280 px passt die Zeile ohne Seitwärtsscrollen. Eine Schwelle für
 * alle Listen, damit sich dieselbe Liste nicht je Seite anders verhält.
 */
export const WIDE_LIST_QUERY = '(min-width: 1280px)';

/**
 * `true` = Tabelle, `false` = Karten. Ohne `matchMedia` (Komponententests)
 * gilt die Tabelle.
 *
 * TABELLE ODER KARTEN, NIE BEIDES im DOM: Zwei Darstellungen mit CSS
 * auszublenden verdoppelte Knöpfe, Links und Rollen — für Tests und für
 * Bildschirmleserinnen.
 */
export function useWideList(): boolean {
  return useMediaQuery(WIDE_LIST_QUERY);
}

/** Die Hülle der Kartenliste — eine Karte je Zeile, durch Linien getrennt. */
export function CardList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul
      aria-label={label}
      className="divide-y divide-rahmen overflow-hidden rounded-xl border border-rahmen bg-flaeche"
    >
      {children}
    </ul>
  );
}

/**
 * Eine Karte. `relative`, damit ein gestreckter Link (`after:absolute
 * after:inset-0` am Namen) die ganze Karte zum Klickziel macht, wie die Zeile
 * der Tabelle.
 */
export function CardListItem({ children }: { children: ReactNode }) {
  return (
    <li className="relative flex items-center gap-3 p-4 transition-colors hover:bg-flaeche-4">
      {children}
    </li>
  );
}
