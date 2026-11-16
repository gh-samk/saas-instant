import { useSyncExternalStore } from 'react';

/**
 * Folgt einer Medienabfrage (z. B. `(min-width: 1024px)`).
 *
 * Wo `matchMedia` fehlt (Komponententests unter jsdom, Renderer ohne Browser),
 * gilt `fallback`. So rendert eine Seite, die zwei Darstellungen NUR EINMAL
 * ins DOM setzen will (Tabelle ODER Karten), dort die Desktop-Fassung —
 * beide gleichzeitig verdoppelten Knöpfe, Dialoge und Rollen.
 */
export function useMediaQuery(query: string, fallback = true): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return () => {};
      }
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () =>
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(query).matches
        : fallback,
    () => fallback,
  );
}
