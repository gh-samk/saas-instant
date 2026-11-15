/**
 * Domänen-Archivierung mit Verwaisungsprüfung (Regel b). Eine Domäne wird nur so
 * archiviert, dass keine Person ohne jede gültige Zugehörigkeit zurückbleibt.
 * Anders als die frühere Auflösung ist das Archivieren reversibel (Wiederbeleben).
 * Alle Datumsfelder sind reine Kalenderdaten (YYYY-MM-DD).
 */

export type ArchiveAction = 'delete' | 'keep_in_domain';

/** Eine Person, die durch die Archivierung verwaisen würde. */
export interface OrphanedPerson {
  personId: string;
  name: string;
  /** Aktuelle soziokratische Rollen dieser Person in der zu archivierenden Domäne. */
  rolesInDomain: string[];
}

/** Eine mögliche Ziel-Domäne, um eine Person weiter aufzunehmen. */
export interface TargetDomainOption {
  id: string;
  name: string;
}

/** Vorschau der Archivierung: wer verwaist, welche Optionen bestehen. */
export interface ArchivePreview {
  domainId: string;
  domainName: string;
  /** Hat die Domäne Vorschläge/Beschlüsse? (Bleiben im Log erhalten.) */
  hasEntries: boolean;
  /**
   * Hat die Domäne noch aktive (nicht archivierte) Unter-Domänen? Dann ist das
   * Archivieren gesperrt, sonst entstünde ein verwaister Teilbaum (Regel A9).
   */
  hasActiveSubDomains: boolean;
  orphaned: OrphanedPerson[];
  /** Andere aktive Domänen der Organisation (mögliche Ziel-Domänen). */
  targetDomains: TargetDomainOption[];
}

/** Entscheidung für EINE verwaisende Person. */
export interface ArchiveChoice {
  personId: string;
  action: ArchiveAction;
  /** Pflicht bei aktion === 'behalten_in_domaene': aufnehmende Domäne. */
  targetDomainId?: string;
}

/** Eingabe zum Archivieren: je verwaisender Person eine Entscheidung. */
export interface ArchiveInput {
  choices: ArchiveChoice[];
}
