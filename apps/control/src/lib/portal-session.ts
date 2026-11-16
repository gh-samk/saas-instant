import { useSyncExternalStore } from 'react';

/**
 * Merkt, ob die laufende Sitzung über das Portal entstanden ist.
 *
 * Bewusst ein winziger eigener Speicher statt eines Contexts: der
 * Nachweisdialog (22 Aufrufer, teils ohne `AuthProvider` getestet) braucht
 * genau diese eine Auskunft, und der `AuthProvider` setzt sie bei jedem Laden
 * des eigenen Stands.
 */
let viaPortal = false;
const listeners = new Set<() => void>();

export function setViaPortal(value: boolean): void {
  if (viaPortal === value) return;
  viaPortal = value;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Ist die Sitzung eine Portal-Sitzung? Dann ist der Nachweis ein Step-up. */
export function useViaPortal(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => viaPortal,
    () => false,
  );
}

/** Der Weg zum Portal: Anmeldung bzw. Step-up (`stepUp`) mit Rücksprungpfad. */
export function ssoStartUrl(returnPath: string, stepUp = false): string {
  const query = new URLSearchParams({ return: returnPath });
  if (stepUp) query.set('stepup', '1');
  return `/api/auth/sso/start?${query.toString()}`;
}

/** Pfad der Seite, die ein Step-up-Fenster nach dem Durchlauf erreicht. */
export const STEP_UP_DONE_PATH = '/step-up-done';
/** Nachrichtentyp, mit dem das Step-up-Fenster das Ergebnis meldet. */
export const STEP_UP_MESSAGE = 'si-step-up';

/**
 * Das Portal sendet `Cross-Origin-Opener-Policy: same-origin`. Ein Fenster, das
 * durch das Portal gelaufen ist, verliert damit `window.opener`, und der
 * Öffner kann sein `closed` nicht mehr zuverlässig lesen. Das Ergebnis geht
 * deshalb über einen BroadcastChannel (gleicher Ursprung, kein Opener nötig).
 */
export function stepUpChannelAvailable(): boolean {
  return typeof BroadcastChannel !== 'undefined';
}

/** Meldet das Ergebnis des Step-ups an das Fenster mit dem Nachweisdialog. */
export function announceStepUp(ok: boolean): boolean {
  if (!stepUpChannelAvailable()) return false;
  const channel = new BroadcastChannel(STEP_UP_MESSAGE);
  channel.postMessage({ type: STEP_UP_MESSAGE, ok });
  channel.close();
  return true;
}

/** Hört auf das Ergebnis eines Step-ups; gibt die Abmeldefunktion zurück. */
export function listenStepUp(onResult: (ok: boolean) => void): () => void {
  if (!stepUpChannelAvailable()) return () => undefined;
  const channel = new BroadcastChannel(STEP_UP_MESSAGE);
  channel.onmessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; ok?: unknown } | null;
    if (data === null || typeof data !== 'object' || data.type !== STEP_UP_MESSAGE) return;
    onResult(data.ok === true);
  };
  return () => channel.close();
}
