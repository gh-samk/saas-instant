import { t } from '../i18n';
import { issueLine, isRawServerText, validationIssues } from './validation-errors';
/**
 * HTTP-Zugang zur Verwaltungs-API.
 *
 * Aufbau bewusst identisch zu `apps/web/src/lib/api-client.ts`: Cookies werden
 * immer mitgeschickt, vor jeder schreibenden Anfrage wird das CSRF-Token
 * beschafft und als Header `x-csrf-token` gesendet (Double-Submit), und Fehler
 * kommen im einheitlichen Format `{ error: { code, message, detail? } }`
 * zurück.
 */
const API_BASIS = (import.meta.env['VITE_API_URL'] as string | undefined) ?? '';

export interface ApiErrorBody {
  code: string;
  message: string;
  detail?: unknown;
}

export class ApiError extends Error {
  constructor(
    public readonly error: ApiErrorBody,
    public readonly status: number,
  ) {
    super(error.message);
    this.name = 'ApiError';
  }
}

/** Fehlercodes, gegen die die Oberfläche programmiert. */
export const ERROR_CODE = {
  loginFailed: 'login_failed',
  accountBlocked: 'account_locked',
  /** Ein E-Mail-Code wurde vor Ablauf der 60 Sekunden erneut angefordert. */
  loginCodeTooEarly: 'login_code_too_early',
  /** Der letzte eingerichtete zweite Faktor lässt sich nicht entfernen. */
  lastFactor: 'last_factor',
  mailSendFailed: 'mail_versand_fehlgeschlagen',
  /** Die Verwaltung ist nach einem Neustart noch gesperrt (HTTP 423). */
  vaultLocked: 'vault_locked',
  /** Modus portal: für diese Aktion fehlt ein frischer Nachweis über das Portal. */
  stepUpRequired: 'step_up_required',
  /** Modus portal: die Rolle des Kontos reicht für diese Aktion nicht. */
  forbiddenRole: 'forbidden_role',
  vaultWrongSecret: 'vault_wrong_secret',
  vaultRateLimited: 'vault_rate_limited',
  vaultUninitialized: 'vault_uninitialized',
  vaultAlreadyInitialized: 'vault_already_initialized',
} as const;

/**
 * Globaler Handler für „Verwaltung gesperrt" (HTTP 423).
 *
 * `apiFetch` und `apiFile` rufen ihn auf, bevor sie den Fehler weiterreichen.
 * So landet jede Seite — egal, welche Anfrage zuerst auf die Sperre stößt —
 * auf der Entsperrseite, ohne dass eine Seite davon wissen muss. Gesetzt wird
 * er vom `VaultProvider`; ohne Handler passiert nichts (Tests, Anmeldeseite).
 */
let vaultLockedHandler: (() => void) | null = null;

export function setVaultLockedHandler(handler: (() => void) | null): void {
  vaultLockedHandler = handler;
}

function reportLocked(response: Response): void {
  if (response.status === 423) vaultLockedHandler?.();
}

/**
 * Grund eines gescheiterten E-Mail-Codes.
 *
 * Der Server reicht ihn nur dort heraus, wo das Passwort bereits bewiesen ist
 * oder eine gültige Sitzung besteht — auf der anonymen Anforderungsroute
 * niemals. Fehlt `detail` (nie angefordert, weggeräumt, falscher Zweck), gibt
 * es keinen Grund und der Aufrufer bleibt beim Text des Servers.
 */
export type EmailCodeReason = 'wrong' | 'burned' | 'expired';

const EMAIL_CODE_REASONS: readonly EmailCodeReason[] = [
  'wrong',
  'burned',
  'expired',
];

export function emailCodeReasonFrom(error: unknown): EmailCodeReason | null {
  if (!(error instanceof ApiError)) return null;
  if (error.error.code !== ERROR_CODE.loginFailed) return null;
  const detail = error.error.detail;
  if (typeof detail !== 'object' || detail === null) return null;
  const reason = (detail as Record<string, unknown>)['reason'];
  return EMAIL_CODE_REASONS.find((g) => g === reason) ?? null;
}

/** Liest `detail.sekundenVerbleibend` aus einem Fehler mit passendem Code. */
function secondsRemainingFrom(
  error: unknown,
  expectedCode: string,
): number | null {
  if (!(error instanceof ApiError)) return null;
  if (error.error.code !== expectedCode) return null;
  const detail = error.error.detail;
  if (typeof detail !== 'object' || detail === null) return null;
  const value = (detail as Record<string, unknown>)['secondsRemaining'];
  return typeof value === 'number' && value > 0 ? Math.ceil(value) : null;
}

/**
 * Restsekunden einer Kontosperre aus dem Fehlerdetail.
 * Gibt null zurück, wenn der Fehler keine Sperre ist — der Aufrufer entscheidet
 * dann selbst, was er anzeigt.
 */
export function blockSecondsFrom(error: unknown): number | null {
  return secondsRemainingFrom(error, ERROR_CODE.accountBlocked);
}

/**
 * Restsekunden bis ein neuer E-Mail-Code angefordert werden darf.
 *
 * Nur der Einrichtungsweg (angemeldet) liefert diese Restzeit; die
 * unauthentifizierte Anmelderoute antwortet bewusst immer gleich und verrät
 * keine Restzeit — dort zählt die Oberfläche ab dem eigenen Absenden.
 */
export function loginCodeWaitSecondsFrom(error: unknown): number | null {
  return secondsRemainingFrom(error, ERROR_CODE.loginCodeTooEarly);
}

/**
 * Rahmenmeldungen, die so nie vor Nutzende gehören. Der Throttler von NestJS
 * antwortet mit „ThrottlerException: Too Many Requests" — englisch, technisch
 * und ohne Handlungshinweis. Hier steht die deutsche Entsprechung.
 */
const FALLBACK_TEXT: Record<string, string> = {
  HTTP_429:
    t('common.apiClient.http429'),
  HTTP_403:
    t('common.apiClient.http403'),
};

/**
 * Der Text, den die Oberfläche zu einem Fehler anzeigt.
 *
 * Reihenfolge: bekannte Rahmenmeldung übersetzen; Prüfmeldungen des Servers
 * auf deutsche Feldbezeichnungen abbilden („Posten 1, Einheit: …", bei mehreren
 * „2 Angaben prüfen"); sonst die fachliche Meldung des Servers im Wortlaut;
 * sonst der übergebene Ersatztext. Rohe Rahmentexte (englisch, technisch)
 * werden durch den Ersatztext ersetzt. Es verschwindet nichts stillschweigend
 * — es wird nur nichts Technisches durchgereicht.
 */
export function errorText(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  const known = FALLBACK_TEXT[error.error.code];
  if (known !== undefined) return known;
  const issues = validationIssues(error);
  if (issues.length === 1 && issues[0] !== undefined) return issueLine(issues[0]);
  if (issues.length > 1) return t('common.validation.count', { count: issues.length });
  return isRawServerText(error.error.message) ? fallback : error.error.message;
}

const SECURE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

let csrfToken: string | null = null;

/** Liest ein Cookie im Browser (das csrf-Cookie ist bewusst nicht httpOnly). */
function readCookie(name: string): string | null {
  const match = document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.split('=')[1] ?? '') : null;
}

/** Holt ein CSRF-Token vom Server und cacht es. Setzt zugleich das csrf-Cookie. */
export async function fetchCsrf(): Promise<string> {
  const response = await fetch(`${API_BASIS}/api/auth/csrf`, {
    credentials: 'include',
  });
  if (!response.ok) {
    throw new ApiError(
      {
        code: `HTTP_${response.status}`,
        message: t('common.apiClient.message'),
      },
      response.status,
    );
  }
  const body = (await response.json()) as { csrfToken: string };
  csrfToken = body.csrfToken;
  return csrfToken;
}

async function csrfHeaderValue(): Promise<string> {
  const fromCookie = readCookie('csrf');
  if (fromCookie) {
    csrfToken = fromCookie;
    return fromCookie;
  }
  if (csrfToken) return csrfToken;
  return fetchCsrf();
}

async function asError(response: Response): Promise<ApiError> {
  let error: ApiErrorBody = {
    code: `HTTP_${response.status}`,
    message: t('common.apiClient.message2', { status: response.status }),
  };
  try {
    const body = (await response.json()) as { error?: ApiErrorBody };
    if (body?.error) error = body.error;
  } catch {
    // Antwort ohne JSON-Körper — Fallback behalten.
  }
  return new ApiError(error, response.status);
}

export async function apiFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const method = (options?.method ?? 'GET').toUpperCase();
  const header: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string> | undefined),
  };

  // Datei-Uploads: den Content-Type setzt der Browser samt Multipart-Grenze.
  if (typeof FormData !== 'undefined' && options?.body instanceof FormData) {
    delete header['Content-Type'];
  }

  if (!SECURE_METHODS.has(method)) {
    header['x-csrf-token'] = await csrfHeaderValue();
  }

  const response = await fetch(`${API_BASIS}${path}`, {
    credentials: 'include',
    // Die Seitenadresse (?token=...) soll nie als Referer zur API gelangen.
    referrerPolicy: 'no-referrer',
    ...options,
    headers: header,
  });

  if (!response.ok) {
    reportLocked(response);
    throw await asError(response);
  }

  const text = await response.text();
  // LEERER KÖRPER WIRD `null`, NICHT `undefined`.
  //
  // Das ist keine Geschmacksfrage. `GET :id/instanz` antwortet bei fehlender
  // Instanz mit 200 und Content-Length 0 — kein `null`, kein Content-Type. Das
  // frühere `undefined` rutschte an jeder `=== null`-Prüfung vorbei, und die
  // Instanz-Karte lief in den „hat Instanz"-Zweig und stürzte auf
  // `instanz.subdomain` ab. Ergebnis: eine vollständig weiße Seite für JEDE
  // Organisation ohne Instanz — am Prüftag 0 von 41, also praktisch jede.
  //
  // `null` heißt „der Server hat geantwortet, es gibt nichts". Genau das ist
  // hier der Fall, und `null` ist der Wert, gegen den die Oberfläche überall
  // ohnehin prüft. Routen ohne Rückgabewert (204) bekommen damit ebenfalls
  // `null` statt `undefined`; keine davon liest ihr Ergebnis aus.
  return (text ? JSON.parse(text) : null) as T;
}

/**
 * Holt eine Datei — für Wege, die kein JSON zurückgeben (PDF, XML).
 *
 * WARUM ES DIESE FUNKTION BRAUCHT. Die Herunterladen-Knöpfe waren einfache
 * Verweise mit `target="_blank"`. Das ist für den Normalfall genau richtig:
 * Der Server setzt `Content-Disposition` samt Dateiname, der Browser macht den
 * Rest, und Mittelklick oder „Link kopieren" funktionieren wie erwartet.
 *
 * Im Fehlerfall aber öffnete sich ein leerer Tab mit dem ROHEN JSON des
 * Servers — gemessen am 31.08.2026, als der Rechnungsdienst nicht lief:
 * `{"fehler":{"code":"rechnungsdienst_nicht_erreichbar",…}}`. Die Meldung
 * darin ist für Menschen geschrieben; sie stand nur an einer Stelle, an der
 * sie niemand lesen soll.
 *
 * Deshalb wird der Klick jetzt abgefangen und die Antwort geprüft, bevor
 * irgendetwas geöffnet wird. Der Verweis BLEIBT trotzdem ein `<a href>` —
 * ohne Skript, mit Mittelklick oder in einem Browser ohne JavaScript
 * funktioniert der alte Weg unverändert weiter.
 */
export async function apiFile(
  path: string,
): Promise<{ blob: Blob; fileName: string | null }> {
  const response = await fetch(`${API_BASIS}${path}`, {
    credentials: 'include',
  });

  if (!response.ok) {
    reportLocked(response);
    throw await asError(response);
  }

  return {
    blob: await response.blob(),
    fileName: fileNameFrom(response.headers.get('content-disposition')),
  };
}

/**
 * Der Dateiname aus `Content-Disposition`.
 *
 * Zuerst `filename*` (RFC 5987, prozentkodiert und mit Zeichensatz) — nur so
 * kommen Umlaute richtig an. Erst danach das einfache `filename`.
 *
 * `null`, wenn nichts Brauchbares dasteht; dann vergibt die Aufruferin einen
 * Namen. Ein aus dem Kopf geratener Name wäre schlechter als ein gesetzter:
 * Bei einer Rechnung steht die Nummer darin, und die soll stimmen.
 */
function fileNameFrom(head: string | null): string | null {
  if (head === null) return null;

  const extended = /filename\*=(?:UTF-8|utf-8)''([^;]+)/.exec(head);
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1]);
    } catch {
      // Kaputte Prozentkodierung: lieber der einfache Name als ein Absturz.
    }
  }

  const simple = /filename="?([^";]+)"?/.exec(head);
  return simple?.[1] ?? null;
}
