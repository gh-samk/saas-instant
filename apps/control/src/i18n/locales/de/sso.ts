/** Namespace `sso`: Anmeldung über das Portal (Modus `portal`). */
export default {
  // --- Anmeldeseite ----------------------------------------------------------
  loginSubtitle: 'Die Anmeldung läuft über das Portal.',
  loginButton: 'Mit dem Portal anmelden',
  emergencyLink: 'Notzugang',
  redirecting: 'Weiterleitung zum Portal …',
  failedTitle: 'Anmeldung fehlgeschlagen',
  failedText:
    'Die Anmeldung über das Portal ist nicht gelungen. Bitte versuche es erneut.',
  retry: 'Erneut mit dem Portal anmelden',
  emergencyHint:
    'Der Notzugang gilt nur für Konten, die dafür auf dem Server eingerichtet wurden.',
  backToPortal: 'Zurück zur Anmeldung über das Portal',
  localDisabled:
    'Dieses Konto hat keinen Notzugang. Bitte melde dich über das Portal an.',

  // --- Kein Zugriff ----------------------------------------------------------
  noAccessTitle: 'Kein Zugriff auf diese Verwaltung',
  noAccessText:
    'Dein Konto hat in dieser Verwaltung keine Rolle. Bitte wende dich an die Kontenverwaltung des Portals.',
  noAccessRetry: 'Erneut anmelden',

  // --- Step-up ---------------------------------------------------------------
  stepUpHint:
    'Bestätige die Aktion mit einer erneuten Anmeldung im Portal, einschließlich zweitem Faktor.',
  stepUpButton: 'Im Portal bestätigen',
  stepUpWaiting: 'Warten auf die Bestätigung im Portal …',
  stepUpFailed:
    'Die Bestätigung im Portal ist nicht gelungen. Bitte versuche es erneut.',
  stepUpBlocked:
    'Das Fenster für die Bestätigung konnte nicht geöffnet werden. Bitte erlaube Pop-ups für diese Seite.',
  stepUpDoneTitle: 'Bestätigt',
  stepUpDoneText: 'Du kannst dieses Fenster schließen.',
  stepUpDoneFailed: 'Die Bestätigung ist nicht gelungen. Du kannst dieses Fenster schließen.',

  // --- Rolle -----------------------------------------------------------------
  roleAdmin: 'Administration',
  roleStaff: 'Mitarbeit',
  roleLabel: 'Rolle: {role}',
  staffReadOnly:
    'Mit der Rolle Mitarbeit kannst du diese Einstellungen ansehen, aber nicht ändern.',
  portalFactorsHint:
    'Passwort und zweiter Faktor dieses Kontos verwaltest du im Portal.',
} as const;
