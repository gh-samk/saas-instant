import type { CompanyStatus } from '.prisma/control-client';

/**
 * Deutsche Bezeichnungen der Status — für den WORTLAUT der systemerzeugten
 * Notizen („Status gewechselt: Testphase → Zahlend, 31.08.2026").
 *
 * Steht im Backend, weil der Notiztext beim Schreiben festgelegt wird und
 * danach unverändert im Verlauf steht. Eine spätere Umbenennung in der
 * Oberfläche darf alte Notizen nicht rückwirkend anders lesen lassen.
 */
export const STATUS_LABEL: Record<CompanyStatus, string> = {
  inquiry: 'Anfrage',
  trial: 'Testphase',
  paying: 'Zahlend',
  exempt: 'Beitragsbefreit',
  ended: 'Beendet',
};

/**
 * Status, die es vor Version 1.2.0 gab. Audit-Einträge behalten ihre Werte;
 * wer sie liest (z. B. die Aufgabe „Status automatisch gewechselt"), braucht
 * die damaligen Bezeichnungen.
 */
export const LEGACY_STATUS_LABEL: Record<string, string> = {
  demo: 'Demo',
  pilot_approved: 'Pilot beschlossen',
  pilot_running: 'Pilot läuft',
  review_pending: 'Überprüfung offen',
  dormant: 'Ruhend',
};

/** Bezeichnung für aktuelle und frühere Statuswerte; Unbekanntes bleibt roh. */
export function statusLabelOf(status: string): string {
  return (
    STATUS_LABEL[status as CompanyStatus] ??
    LEGACY_STATUS_LABEL[status] ??
    status
  );
}
