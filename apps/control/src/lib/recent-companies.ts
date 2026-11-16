/**
 * Zuletzt geöffnete Organisationen, für die Kommandopalette.
 *
 * Liegt im `localStorage` dieses Browsers und nirgends sonst: Es ist eine
 * Bedienhilfe, kein Datenbestand. Jeder Zugriff ist abgesichert — im privaten
 * Fenster oder bei gesperrtem Speicher gibt es einfach keine Liste.
 */
export interface RecentCompany {
  id: string;
  name: string;
}

const STORAGE_KEY = 'saas-instant.control.recent-companies';
export const RECENT_MAX = 5;

function isRecent(value: unknown): value is RecentCompany {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RecentCompany).id === 'string' &&
    typeof (value as RecentCompany).name === 'string' &&
    (value as RecentCompany).id !== '' &&
    (value as RecentCompany).name !== ''
  );
}

export function readRecentCompanies(): RecentCompany[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecent).slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** Setzt die Organisation an den Anfang; Doppelte fallen weg, der Rest wird gekürzt. */
export function rememberCompany(company: RecentCompany): void {
  if (!isRecent(company)) return;
  try {
    const next = [
      { id: company.id, name: company.name },
      ...readRecentCompanies().filter((c) => c.id !== company.id),
    ].slice(0, RECENT_MAX);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Speicher nicht verfügbar — dann gibt es eben keine Liste.
  }
}
