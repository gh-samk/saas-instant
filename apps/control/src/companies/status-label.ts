import type { CompanyStatus } from '.prisma/control-client';

/**
 * Deutsche Bezeichnungen der Status — für den WORTLAUT der systemerzeugten
 * Notizen („Status gewechselt: Pilot läuft → Zahlend, 31.08.2026").
 *
 * Steht im Backend, weil der Notiztext beim Schreiben festgelegt wird und
 * danach unverändert im Verlauf steht. Eine spätere Umbenennung in der
 * Oberfläche darf alte Notizen nicht rückwirkend anders lesen lassen.
 */
export const STATUS_LABEL: Record<CompanyStatus, string> = {
  inquiry: 'Anfrage',
  demo: 'Demo',
  pilot_approved: 'Pilot beschlossen',
  pilot_running: 'Pilot läuft',
  paying: 'Zahlend',
  review_pending: 'Überprüfung offen',
  dormant: 'Ruhend',
  ended: 'Beendet',
};
