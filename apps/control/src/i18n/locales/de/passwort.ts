/** Namespace `passwort`: „Neues Passwort setzen" über den Notfall-Link (NewPasswordPage). */
export default {
  brand: 'Verwaltung',
  subtitle: 'Neues Passwort setzen',
  checkingLink: 'Link wird geprüft …',
  invalidTitle: 'Link ungültig',
  invalidText:
    'Dieser Link ist abgelaufen oder wurde bereits verwendet. Fordere über die Kommandozeile einen neuen an.',
  doneText: 'Passwort gesetzt. Du kannst dich jetzt anmelden.',
  toLogin: 'Zur Anmeldung',
  introNoCountdown:
    'Setze über diesen einmaligen Link ein Passwort. Er lässt sich genau einmal einlösen.',
  introCountdownBefore:
    'Setze über diesen einmaligen Link ein neues Passwort. Der Link ist noch',
  introCountdownAfter: 'gültig.',
  repeatMismatch: 'Die Passwörter stimmen nicht überein.',
  setFailed: 'Das Passwort konnte nicht gesetzt werden.',
  submit: 'Passwort setzen',
} as const;
