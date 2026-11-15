/**
 * Zentrale deutsche Anzeigetexte für die Backend-Enum-Werte (korrekte
 * Großschreibung). In shared, damit Web-Frontend UND API (z. B. PDF-Export)
 * dieselben Bezeichnungen nutzen und nicht auseinanderlaufen.
 */
import type {
  GovernanceType,
  ValidityStatus,
  Term,
  ObjectionSeverity,
  ProposalStatus,
} from './process';
import type { DomainType } from './domain';

export const GOVERNANCE_LABEL: Record<GovernanceType, string> = {
  governance: 'Governance',
  operational: 'Operativ',
};

export const PROPOSAL_STATUS_LABEL: Record<ProposalStatus, string> = {
  open: 'Offen',
  decided: 'Entschieden',
  withdrawn: 'Zurückgezogen',
};

export const VALIDITY_STATUS_LABEL: Record<ValidityStatus, string> = {
  valid: 'Gültig',
  in_review: 'In Überprüfung',
  replaced: 'Ersetzt',
  ended: 'Beendet',
};

export const TERM_LABEL: Record<Term, string> = {
  fixed_term: 'Befristet',
  open_ended: 'Unbefristet',
};

export const SEVERITY_LABEL: Record<ObjectionSeverity, string> = {
  minor: 'Leicht',
  severe: 'Schwerwiegend',
};

export const DOMAIN_TYPE_LABEL: Record<DomainType, string> = {
  permanent_domain: 'Dauerdomäne',
  working_domain: 'Arbeitsdomäne',
};
