/**
 * Farbschema: System (Vorgabe), Hell oder Dunkel.
 *
 * "system" setzt KEIN data-theme am html-Element, dann entscheidet
 * prefers-color-scheme. Hell/Dunkel setzen data-theme und überschreiben das
 * System. Die Wahl liegt in localStorage (try/catch: der Speicher kann
 * gesperrt sein, die Seite funktioniert dann ohne Merken).
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'saas-instant.theme';

export function readTheme(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

export function saveTheme(choice: ThemeChoice): void {
  applyTheme(choice);
  try {
    if (choice === 'system') window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    /* Speicher nicht verfügbar: Wahl gilt nur für diese Sitzung. */
  }
}
