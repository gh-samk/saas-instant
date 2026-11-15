/**
 * Die öffentliche Auskunft einer Kundeninstanz: Ist sie eingerichtet?
 *
 * `GET /api/setup/status` antwortet ohne Anmeldung und ohne Token mit
 * `{ benoetigtSetup, … }` — dieselbe Auskunft, mit der die Instanz selbst
 * entscheidet, ob sie den Assistenten zeigt. Sie enthält nichts, was nicht
 * jeder Besucher der Subdomain ohnehin sieht.
 *
 * DREI ANTWORTEN, NICHT ZWEI. `unbekannt` ist kein „offen": Eine Instanz, die
 * gerade neu startet oder hinter einer Störung steht, darf weder als
 * eingerichtet gelten (der Link verschwände, obwohl ihn noch jemand braucht)
 * noch den bekannten Stand überschreiben.
 */
export type SetupStatus = 'configured' | 'open' | 'unknown';

/** Auswechselbar, damit Tests ohne Netz laufen — Muster `METRICS_FETCH`. */
export type SetupStatusFetch = (
  url: string,
  timeoutMs: number,
) => Promise<SetupStatus>;

/** Injektionsmarke — Vorgabewerte kennt der Injector nicht ([K6]). */
export const SETUP_STATUS_FETCH = 'SETUP_STATUS_FETCH';

/**
 * Knapp bemessen: Die Abfrage läuft, während die Detailseite lädt. Eine
 * hängende Instanz soll die Seite höchstens diese Zeit aufhalten.
 */
export const SETUP_STATUS_TIMEOUT_MS = 5_000;

export const getSetupStatusViaHttp: SetupStatusFetch = async (
  url,
  timeoutMs,
) => {
  const abort = new AbortController();
  const clock = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: abort.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return 'unknown';
    return setupStatusFrom((await response.json()) as unknown);
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(clock);
  }
};

/** Liest die Antwort streng: nur ein echtes `boolean` zählt. */
export function setupStatusFrom(raw: unknown): SetupStatus {
  if (typeof raw !== 'object' || raw === null) return 'unknown';
  const value = (raw as Record<string, unknown>)['benoetigtSetup'];
  if (value === false) return 'configured';
  if (value === true) return 'open';
  return 'unknown';
}
