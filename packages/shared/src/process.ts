/**
 * Gemeinsame Antwort-DTOs für den Kern-Flow (Vorschlag → Bedenken/Einwände →
 * Beschluss). Von API (Antwort-Form) und Web-Frontend genutzt.
 *
 * Anonymität (docs/02): Der Beschluss wird nur als Rollen-Label
 * „Logbuchführer <Domäne>" ausgegeben, NIE als Klarname. Der Vorschlag zeigt
 * dagegen den echten Namen der erfassenden Person (administrative Handlung,
 * analog zu bestaetigtVonName im Änderungslog) – die Person ist immer die
 * zum Erfassungszeitpunkt gültige Logbuchführung des Domäne.
 * Bedenken/Einwände enthalten gar keinen Urheber.
 * Alle datum-Felder sind reine Kalenderdaten im Format YYYY-MM-DD.
 */

export type GovernanceType = 'governance' | 'operational';
export type ProposalStatus = 'open' | 'decided' | 'withdrawn';
export type ObjectionSeverity = 'minor' | 'severe';
export type Term = 'fixed_term' | 'open_ended';
export type ValidityStatus =
  | 'valid'
  | 'in_review'
  | 'replaced'
  | 'ended';

/** Bedenken – bewusst ohne Urheber (anonym). */
export interface ConcernDTO {
  id: string;
  content: string;
  date: string;
}

/** Einwand – bewusst ohne Urheber (anonym). */
export interface ObjectionDTO {
  id: string;
  content: string;
  severity: ObjectionSeverity;
  integration: string | null;
  date: string;
}

/** Verweis auf einen anderen Beschluss/Vorschlag (Ablösungskette). */
export interface DecisionReference {
  decisionId: string;
  proposalId: string;
  title: string;
}

/** Beschluss – Handlung, daher mit Rollen-Label statt Klarname. */
export interface DecisionDTO {
  id: string;
  content: string;
  note: string | null;
  term: Term;
  reviewDate: string | null;
  validityStatus: ValidityStatus;
  validFrom: string;
  validUntil: string | null;
  date: string;
  recordedByLabel: string;
  /** Beschluss, den dieser abgelöst hat (null, wenn eigenständig). */
  replacesDecisionId: string | null;
  /** Nachfolger, der diesen Beschluss abgelöst hat (bei status=ersetzt). */
  replacedBy: DecisionReference | null;
}

/** Vorschlag mit verschachtelten Einträgen. */
export interface ProposalDTO {
  id: string;
  domainId: string;
  title: string;
  content: string;
  governanceType: GovernanceType;
  status: ProposalStatus;
  date: string;
  /** Echter Name der Person, die den Vorschlag erfasst hat (kein Rollenlabel). */
  recordedByName: string;
  concerns: ConcernDTO[];
  objections: ObjectionDTO[];
  decision: DecisionDTO | null;
  /** Gesetzt, wenn dieser Vorschlag eine Neufassung ist (löst einen Beschluss ab). */
  revisionOf: DecisionReference | null;
}
