/**
 * Anzeigeform einer Peer-Adresse.
 *
 * Der Server normalisiert IPv4-gemappte IPv6-Adressen („::ffff:127.0.0.1")
 * seit der Korrektur von `common/ip-address.ts` schon beim Schreiben. ALTDATEN
 * im Sicherheitsprotokoll tragen noch die rohe Form; deshalb gilt dieselbe
 * Regel auch hier in der Anzeige. Alles andere (echte IPv6, Hostnamen) bleibt
 * unverändert; leer oder `null` ergibt `null`.
 */
export function displayIp(ip: string | null | undefined): string | null {
  if (typeof ip !== 'string') return null;
  const trimmed = ip.trim();
  if (trimmed === '') return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  return mapped ? mapped[1] : trimmed;
}
