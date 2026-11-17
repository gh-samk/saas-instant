/**
 * Subdomains: Vorschlag, Normalisierung, Prüfung.
 *
 * DER ZWECK IST EIN TIPPFEHLER, DER AUFFÄLLT. Der Auftrag nennt den Grund:
 * „Eine falsch getippte Subdomain, die eine bestehende überschreibt, ist bei
 * voller Automatik ein stiller Datenverlust." Die erste der drei Maßnahmen
 * dagegen steht hier: Wer den Vorschlag aus dem bereits geprüften
 * Organisationsnamen übernimmt, tippt gar nichts, das falsch sein könnte.
 */

/** Höchstlänge einer Subdomain. Ein DNS-Label darf 63 Zeichen haben. */
export const SUBDOMAIN_MAX = 63;

/** Nur Kleinbuchstaben, Ziffern und Bindestriche, nicht am Rand. */
export const SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Namen, die keine Kundeninstanz tragen darf.
 *
 * `www`, `api` und Konsorten sind die Adressen des Betriebs selbst. Eine
 * Kundeninstanz darunter wäre nicht nur verwirrend — sie stünde in der
 * DNS-Wildcard vor der eigentlichen Anwendung.
 */
export const BLOCKED_SUBDOMAINS = [
  'www',
  'api',
  'app',
  'mail',
  'smtp',
  'demo',
  'admin',
  'verwaltung',
  'control',
  'status',
  'test',
  'staging',
  // `instances/invoices/` im Sicherungsziel läge sonst neben dem Rechnungsarchiv `invoices/`.
  'invoices',
] as const;

const UMLAUTS: Record<string, string> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  ß: 'ss',
  à: 'a',
  á: 'a',
  â: 'a',
  è: 'e',
  é: 'e',
  ê: 'e',
  ë: 'e',
  í: 'i',
  ï: 'i',
  ó: 'o',
  ô: 'o',
  ú: 'u',
  û: 'u',
  ç: 'c',
  ñ: 'n',
};

/**
 * Wörter, die im Vorschlag entfallen: Rechtsformen und Füllwörter.
 *
 * „Musterverein Ostend e. V." soll `musterverein-ostend` vorschlagen, nicht
 * `musterverein-ostend-e-v`.
 */
const OMIT = new Set([
  'ev',
  'e',
  'v',
  'gmbh',
  'ug',
  'kg',
  'ag',
  'gbr',
  'ggmbh',
  'mbh',
  'co',
  'und',
  'der',
  'die',
  'das',
  'fuer',
]);

/** Macht aus beliebiger Eingabe eine zulässige Subdomain-Schreibweise. */
export function normalizeSubdomain(input: string): string {
  const small = input.toLowerCase();
  let replaced = '';
  for (const character of small) {
    replaced += UMLAUTS[character] ?? character;
  }
  return replaced
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, SUBDOMAIN_MAX)
    .replace(/-$/, '');
}

/** Der Vorschlag aus dem Organisationsnamen. */
export function subdomainSuggestion(companyName: string): string {
  const parts = normalizeSubdomain(companyName)
    .split('-')
    .filter((part) => part.length > 0 && !OMIT.has(part));
  const suggestion = parts.join('-').slice(0, SUBDOMAIN_MAX).replace(/-$/, '');
  // Bleibt nichts übrig (Name bestand nur aus Rechtsform/Füllwörtern), ist der
  // ungefilterte Wert immer noch besser als ein leeres Feld.
  return suggestion.length > 0 ? suggestion : normalizeSubdomain(companyName);
}

/** Warum eine Subdomain unzulässig ist — oder `null`, wenn sie es nicht ist. */
export function subdomainError(value: string): string | null {
  if (value.length === 0) return 'Die Subdomain fehlt.';
  if (value.length > SUBDOMAIN_MAX) {
    return `Die Subdomain darf höchstens ${SUBDOMAIN_MAX} Zeichen haben.`;
  }
  if (!SUBDOMAIN_PATTERN.test(value)) {
    return (
      'Erlaubt sind nur Kleinbuchstaben, Ziffern und Bindestriche — und kein ' +
      'Bindestrich am Anfang oder Ende.'
    );
  }
  if ((BLOCKED_SUBDOMAINS as readonly string[]).includes(value)) {
    return `„${value}" ist für den Betrieb reserviert und nicht vergebbar.`;
  }
  return null;
}
