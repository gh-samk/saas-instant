/**
 * Zuletzt geöffnete Organisationen, für die Kommandopalette.
 *
 * GESPEICHERT WERDEN NUR KENNUNGEN, keine Namen: Ein Organisationsname ist ein
 * Kundendatum und gehört nicht unverschlüsselt in den `localStorage`, wo er
 * Abmelden, Sperre und Benutzerwechsel überlebte. Die Namen holt die Palette beim
 * Öffnen vom Server nach (dort greift Anmeldung und Tresor).
 *
 * Der Schlüssel gilt je Benutzer, damit ein zweites Konto an demselben Browser
 * die Liste des ersten nicht sieht. Beim Abmelden und bei gesperrtem Tresor (423)
 * wird alles geleert (`clearRecentCompanies`), auch der frühere Schlüssel, unter
 * dem noch Namen liegen konnten.
 *
 * Es ist eine Bedienhilfe, kein Datenbestand. Jeder Zugriff ist abgesichert — im
 * privaten Fenster oder bei gesperrtem Speicher gibt es einfach keine Liste.
 */
const KEY_PREFIX = 'saas-instant.control.recent-companies';
/** Schlüssel der Fassung, die Namen speicherte. Wird nur noch gelöscht. */
const LEGACY_KEY = KEY_PREFIX;
export const RECENT_MAX = 5;

const keyFor = (userId: string): string => `${KEY_PREFIX}.${userId}`;

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && value.length <= 100;

export function readRecentCompanyIds(userId: string | null | undefined): string[] {
  if (!userId) return [];
  try {
    const raw = localStorage.getItem(keyFor(userId));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Nur Zeichenketten: Alles andere (auch ein früherer Eintrag mit Namen) fällt weg.
    return parsed.filter(isId).slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** Setzt die Organisation an den Anfang; Doppelte fallen weg, der Rest wird gekürzt. */
export function rememberCompanyId(userId: string | null | undefined, id: string): void {
  if (!userId || !isId(id)) return;
  try {
    const next = [id, ...readRecentCompanyIds(userId).filter((c) => c !== id)].slice(
      0,
      RECENT_MAX,
    );
    localStorage.setItem(keyFor(userId), JSON.stringify(next));
  } catch {
    // Speicher nicht verfügbar — dann gibt es eben keine Liste.
  }
}

/** Nimmt eine Kennung heraus (Organisation gelöscht oder nicht mehr erreichbar). */
export function forgetCompanyId(userId: string | null | undefined, id: string): void {
  if (!userId) return;
  try {
    const rest = readRecentCompanyIds(userId).filter((c) => c !== id);
    localStorage.setItem(keyFor(userId), JSON.stringify(rest));
  } catch {
    // siehe oben
  }
}

/** Leert die Listen ALLER Benutzer und den früheren Schlüssel (Abmelden, Sperre). */
export function clearRecentCompanies(): void {
  try {
    const doomed: string[] = [LEGACY_KEY];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key !== null && key.startsWith(`${KEY_PREFIX}.`)) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch {
    // Speicher nicht verfügbar — dann liegt auch nichts darin.
  }
}
