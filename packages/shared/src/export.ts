/**
 * Typen rund um den PDF-Export. Einzel-Beschluss- und Domänen-Export liefern
 * direkt eine PDF-Datei (kein DTO nötig); der Organisations-Gesamt-Export läuft
 * asynchron und wird per Mail zugestellt – dafür diese Start-Antwort.
 */
import type { DomainDetailDTO } from './domain';
import type { ProposalDTO } from './process';

/** Antwort auf das Anfragen des Org-Gesamt-Exports (202, Zustellung per Mail). */
export interface ExportStartResponse {
  status: 'being_created';
  /** Adresse, an die das fertige PDF geschickt wird. */
  email: string;
}

/** Eine Domäne samt aller ihrer Vorgänge – Baustein des Gesamt-Exports. */
export interface CompanyExportGroup {
  domain: DomainDetailDTO;
  proposals: ProposalDTO[];
}
