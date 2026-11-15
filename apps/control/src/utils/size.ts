/**
 * Byte-Größe zur ANZEIGE, deutsches Zahlenformat: „2,4 GB".
 *
 * Keine Bibliothek dafür — `Intl.NumberFormat` steht im Browser ohnehin bereit
 * und liefert das Komma als Dezimaltrennzeichen, das im Rest der Anwendung
 * (Beträge) ebenfalls gilt.
 */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < UNITS.length - 1) {
    value /= 1024;
    i++;
  }
  // Eine Nachkommastelle nur, wo sie etwas unterscheidet: „2,4 GB" ist eine
  // Aussage, „2,4 KB" auch — „1.024,0 MB" wäre nur Nachkommarauschen.
  const decimalPlaces = i > 0 && value < 10 ? 1 : 0;
  const formatted = new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: decimalPlaces,
    maximumFractionDigits: decimalPlaces,
  }).format(value);
  return `${formatted} ${UNITS[i]}`;
}
