/**
 * Bringt eine Peer-Adresse in die lesbare Form.
 *
 * Node meldet IPv4-Clients auf einem Dual-Stack-Socket als IPv4-mapped IPv6
 * („::ffff:127.0.0.1"). Im Audit-Log und in der Anzeige gehört dort die
 * IPv4-Adresse hin. Alles andere (echte IPv6, Hostnamen, Unbekanntes) bleibt
 * unverändert; leer oder `null` bleibt `null`.
 */
export function normalizeIp(ip: string | null | undefined): string | null {
  if (typeof ip !== 'string') return null;
  const trimmed = ip.trim();
  if (trimmed === '') return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  return mapped ? mapped[1] : trimmed;
}
