import type { ErrorClass } from '../mail/mail.service';

/**
 * Die zwei Postausgänge, für die die Verwaltung geradesteht.
 *
 * - `verwaltung`: `SMTP_*` — Anmeldecodes, Aufnahmelinks, Rechnungen,
 *   Rundmails.
 * - `instanzen`: `CONTROL_INSTANCE_SMTP_*` — den gibt die Verwaltung jeder
 *   neu angelegten Instanz mit (Einladungen, „Passwort vergessen").
 *
 * Heute ist das dasselbe Postfach. Getrennt wird trotzdem, weil es zwei
 * Konfigurationen sind, die einzeln falsch sein können.
 */
export type OutboxRole = 'admin' | 'instances';

export type OutboxState =
  /** Die letzte Prüfung (oder der letzte Versand) ist gelungen. */
  | 'in_ordnung'
  | 'gestoert'
  /** Nur `instanzen`: Coolify ist eingerichtet, der Postausgang dafür nicht. */
  | 'nicht_eingerichtet'
  /** Noch keine Prüfung gelaufen, oder es gibt nichts zu prüfen. */
  | 'ungeprueft';

/**
 * Der Stand eines Postausgangs, wie ihn das Dashboard braucht.
 *
 * `klasse` ist eine feste Kategorie aus `klassifiziere()`, NIE der Wortlaut
 * des Relays — derselbe Grundsatz wie in der bestehenden Betriebsanzeige
 * `GET /api/auth/postausgang`.
 */
export interface OutboxSituation {
  role: OutboxRole;
  state: OutboxState;
  /** Zeitpunkt der letzten Probe (ISO), oder null. */
  checkedAt: string | null;
  /** Seit wann ununterbrochen gestört (ISO) — nur bei `gestoert`. */
  disruptedSince: string | null;
  errorClass: ErrorClass | null;
  /** Woher die Störung bekannt ist — nur bei `gestoert`. */
  detectedBy: 'probe' | 'send' | null;
}
