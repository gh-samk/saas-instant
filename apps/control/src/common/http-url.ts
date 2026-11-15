/**
 * Eine Webadresse, die als Verweis (`href`) taugt: nur `http:` und `https:`.
 *
 * Quelle der Wahrheit für Backend (Validierung) UND Frontend (Anzeige). Eine
 * öffentlich eingereichte „Website" wie `javascript:…` oder `data:…` würde in
 * der Verwaltung sonst als anklickbarer Link gerendert.
 *
 * Reine Funktion ohne Abhängigkeiten, damit sie in beide Teile importierbar ist.
 */
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text === '' || /[\u0000-\u001f\u007f\s]/.test(text)) return false;
  try {
    const url = new URL(text);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch {
    return false;
  }
}

/** Die Adresse für ein `href`, oder `null`, wenn sie kein http(s)-Link ist. */
export function safeHref(value: string | null | undefined): string | null {
  return isHttpUrl(value) ? value.trim() : null;
}
