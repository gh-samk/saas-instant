/**
 * Antwort-DTOs der Zeit-/Gültigkeits-Engine (Stand zum Stichtag, Gantt,
 * fällige Überprüfungen). Alle Datumsfelder sind reine Kalenderdaten
 * im Format YYYY-MM-DD.
 */
import type { Term, ValidityStatus } from './process';

/** Ein am Stichtag geltender Beschluss (mit Titel des Vorschlags). */
export interface StateDecisionDTO {
  id: string;
  proposalId: string;
  title: string;
  content: string;
  validFrom: string;
  validUntil: string | null;
  validityStatus: ValidityStatus;
  term: Term;
  reviewDate: string | null;
  recordedByLabel: string;
}

/** Stand einer Domäne (Domäne) zum Stichtag. */
export interface DomainStateDTO {
  domainId: string;
  domainName: string;
  decisions: StateDecisionDTO[];
}

/** Ein Beschluss als Zeitspanne im Gesamt-Log (Gantt). */
export interface OverallLogSpan {
  id: string;
  /** Zugehöriger Vorschlag (für den Deep-Link-Klick in den Domänen-Log). */
  proposalId: string;
  title: string;
  /** Volltext des zugrundeliegenden Vorschlags (für die Freitextsuche). */
  proposalContent: string;
  /** Beschlusstext (für die Freitextsuche). */
  decisionContent: string;
  validFrom: string;
  validUntil: string | null;
  validityStatus: ValidityStatus;
  term: Term;
  reviewDate: string | null;
  /** Beschluss, den diese Spanne abgelöst hat – zum Verketten der Segmente. */
  replacesDecisionId: string | null;
}

/** Ein offener Vorschlag als Punkt-Ereignis im Gesamt-Log. */
export interface OverallLogPoint {
  id: string;
  title: string;
  /** Volltext des Vorschlags (für die Freitextsuche). */
  proposalContent: string;
  date: string;
}

/** Gesamt-Log-Daten pro Domäne (Spannen + offene Vorschläge). */
export interface OverallLogDomain {
  domainId: string;
  domainName: string;
  spans: OverallLogSpan[];
  openProposals: OverallLogPoint[];
}

/** Ein fälliger befristeter Beschluss (nur Erkennung). */
export interface DueReviewDTO {
  id: string;
  proposalId: string;
  title: string;
  validFrom: string;
  reviewDate: string;
}
