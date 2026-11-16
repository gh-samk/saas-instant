export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;

/** Liefert eine deutsche Fehlermeldung oder null, wenn das Passwort zulässig ist. */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Das Passwort braucht mindestens ${PASSWORD_MIN_LENGTH} Zeichen.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Das Passwort darf höchstens ${PASSWORD_MAX_LENGTH} Zeichen lang sein.`;
  if (password.toLowerCase() === email.toLowerCase()) return 'Das Passwort darf nicht der E-Mail-Adresse entsprechen.';
  return null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
