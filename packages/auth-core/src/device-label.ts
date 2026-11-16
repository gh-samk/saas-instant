/**
 * Baut aus dem User-Agent eine für Menschen lesbare Gerätebezeichnung,
 * z. B. „Merk-Gerät · Safari auf macOS".
 *
 * Bewusst grob: die Bezeichnung dient nur dem Wiedererkennen in der
 * Geräteliste. Sie ist kein Sicherheitsmerkmal und wird nirgends geprüft.
 */
export function labelFromUserAgent(
  prefix: string,
  userAgent: string | null,
): string {
  if (!userAgent) return `${prefix} · Unbekanntes Gerät`;

  const browser = ((): string => {
    if (userAgent.includes('Edg/')) return 'Edge';
    if (userAgent.includes('OPR/')) return 'Opera';
    if (userAgent.includes('Firefox/')) return 'Firefox';
    if (userAgent.includes('Chrome/')) return 'Chrome';
    if (userAgent.includes('Safari/')) return 'Safari';
    return 'Browser';
  })();

  const system = ((): string => {
    if (userAgent.includes('iPhone')) return 'iPhone';
    if (userAgent.includes('iPad')) return 'iPad';
    if (userAgent.includes('Android')) return 'Android';
    if (userAgent.includes('Mac OS X') || userAgent.includes('Macintosh')) {
      return 'macOS';
    }
    if (userAgent.includes('Windows')) return 'Windows';
    if (userAgent.includes('Linux')) return 'Linux';
    return 'unbekanntem System';
  })();

  return `${prefix} · ${browser} auf ${system}`;
}
