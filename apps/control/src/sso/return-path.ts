/**
 * Prüft den Rücksprungpfad nach der Anmeldung.
 *
 * Erlaubt ist nur ein Pfad INNERHALB der Verwaltung: beginnt mit genau einem
 * Schrägstrich, enthält weder Rück-Schrägstrich noch Steuerzeichen und ist
 * nicht länger als 512 Zeichen. Alles andere (eine fremde Adresse, `//host`,
 * `/\host`) ersetzt `/` — sonst wäre die Anmeldung eine offene Weiterleitung.
 */
export function assertAllowedReturnPath(raw: string | undefined): string {
  if (raw === undefined || raw === '') return '/';
  if (raw.length > 512) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return '/';
  // Die Anmelde- und SSO-Wege selbst sind kein Ziel (Schleife).
  if (raw.startsWith('/login') || raw.startsWith('/api/')) return '/';
  return raw;
}
