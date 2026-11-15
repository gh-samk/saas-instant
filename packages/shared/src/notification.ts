/**
 * Benachrichtigungen: Ereignis (Benachrichtigung) plus Pro-Person-Lesestatus
 * (BenachrichtigungEmpfang). Alle Datumsfelder sind reine Kalenderdaten.
 */

import type { CorrectionTargetType } from './correction';

export type NotificationType =
  | 'review_due'
  | 'correction_requested'
  | 'correction_confirmed'
  | 'correction_rejected'
  | 'proposal_new'
  | 'decision_new';

/** Eine Benachrichtigung aus Sicht der angemeldeten Person (mit Lesestatus). */
export interface NotificationDTO {
  /** ID der Benachrichtigung (nicht des Empfangs). */
  id: string;
  type: NotificationType;
  content: string;
  domainId: string | null;
  domainName: string | null;
  dueAt: string | null;
  createdAt: string;
  read: boolean;
  readAt: string | null;
  /** Für den Sprung zum Beschluss (Überprüfung). */
  relatesToDecisionId: string | null;
  proposalId: string | null;
  /** Für den Sprung in den Änderungslog (Korrektur). */
  relatesToCorrectionId: string | null;
  /** Bereich der betroffenen Korrektur (nur bei Korrektur-Benachrichtigungen). */
  correctionTargetType: CorrectionTargetType | null;
}

/** Lesestand einer Benachrichtigung: wie viele Empfänger schon gelesen haben. */
export interface ReadStatusDTO {
  read: number;
  total: number;
  /** true, wenn Empfänger vorhanden sind, aber noch niemand gelesen hat. */
  flagged: boolean;
}

export interface UnreadCountDTO {
  count: number;
}
