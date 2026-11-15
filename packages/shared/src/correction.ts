/**
 * Korrektur-Workflow: feldweise Änderung an bestehenden (sonst unveränderlichen)
 * Einträgen über einen Antrag, den ein Admin bestätigt. Plus Änderungslog.
 * Alle Datumsfelder sind reine Kalenderdaten im Format YYYY-MM-DD.
 */

export type CorrectionTargetType = 'proposal' | 'concerns' | 'objection' | 'decision';
export type CorrectionStatus = 'open' | 'confirmed' | 'rejected';

/**
 * WHITELIST der korrigierbaren Felder je Zieltyp. EINE gemeinsame Quelle für
 * Backend (harte Sicherheitsgrenze: nur diese Felder dürfen je über eine
 * Korrektur geschrieben werden) und Frontend (nur diese Felder sind editierbar).
 * Zeit-, Status-, Gültigkeits-, Schweregrad- und Governance-Felder sind bewusst
 * NICHT korrigierbar – sonst ließe sich der Log über die Korrektur verfälschen.
 */
export const CORRECTABLE_FIELDS: Record<CorrectionTargetType, readonly string[]> = {
  proposal: ['title', 'content'],
  concerns: ['content'],
  objection: ['content', 'integration'],
  // ueberpruefungsdatum deckt zugleich die Befristung ab: leerer Wert ⇒
  // unbefristet, ein Datum ⇒ befristet bis zu diesem Tag.
  decision: ['content', 'note', 'reviewDate'],
};

/** Ist das Feld für den Zieltyp korrigierbar (gegen die Whitelist)? */
export function isCorrectable(targetType: CorrectionTargetType, field: string): boolean {
  return CORRECTABLE_FIELDS[targetType]?.includes(field) ?? false;
}

/** Eingabe zum Stellen eines Korrekturantrags. */
export interface CorrectionRequestInput {
  targetType: CorrectionTargetType;
  targetId: string;
  field: string;
  newContent: string;
  reason?: string;
}

/** Ein offener Korrekturantrag für die Admin-Queue. */
export interface CorrectionRequestDTO {
  id: string;
  targetType: CorrectionTargetType;
  field: string;
  oldContent: string;
  newContent: string;
  reason: string | null;
  /** Antragsteller namentlich (immer angezeigt). */
  requestedByName: string;
  /** Optionales Rollen·Domäne-Label ("Logbuchführend · <Domäne>"). */
  requestedByLabel: string;
  requestedAt: string;
  proposalId: string;
  proposalTitle: string;
  domainName: string;
}

/** Ein bestätigter oder abgelehnter Eintrag im Korrekturen-Log (für alle lesbar). */
export interface ChangeLogEntryDTO {
  id: string;
  targetType: CorrectionTargetType;
  field: string;
  oldContent: string;
  newContent: string;
  /** Antragsteller namentlich (immer angezeigt). */
  requestedByName: string;
  /** Optionales Rollen·Domäne-Label. */
  requestedByLabel: string;
  /** Entscheidender Admin mit Klarname. */
  confirmedByName: string;
  requestedAt: string;
  decidedAt: string;
  proposalId: string;
  proposalTitle: string;
  domainName: string;
  /** Status des Eintrags (bestaetigt oder abgelehnt). */
  status: CorrectionStatus;
  /** Begründung des Admins bei Ablehnung (nur bei status = abgelehnt gesetzt). */
  rejectionReason: string | null;
  /** Benachrichtigung dieser Bestätigung (für den Lesestand), falls vorhanden. */
  notificationId: string | null;
}
