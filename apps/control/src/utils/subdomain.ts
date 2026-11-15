import { t } from '../i18n';
/**
 * Subdomain-Eingabe im Browser: normalisieren und das FORMAT prüfen.
 *
 * BEWUSST NUR DAS FORMAT. Der Vorschlag aus dem Organisationsnamen, die Liste
 * der für den Betrieb reservierten Namen und die Verfügbarkeit kommen vom
 * Server (`holeSubdomainVorschlag`, `pruefeSubdomain`) — eine zweite Fassung
 * dieser Regeln im Browser liefe irgendwann auseinander, und ausgerechnet hier
 * wäre die Abweichung ein Tippfehler, der NICHT auffällt.
 *
 * Muster und Höchstlänge spiegeln `SUBDOMAIN_MUSTER` und `SUBDOMAIN_MAX` aus
 * `apps/control/src/coolify/subdomain.ts`. Sie stehen hier noch einmal, weil
 * Backend-Code nicht ins Browser-Bündel gehört (die Trennlinie steht in
 * `tsconfig.json`); `subdomain.test.ts` hält beide Fassungen aneinander.
 */

/** Höchstlänge einer Subdomain. Ein DNS-Label darf 63 Zeichen haben. */
export const SUBDOMAIN_MAX = 63;

/** Nur Kleinbuchstaben, Ziffern und Bindestriche, nicht am Rand. */
const SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const UMLAUTS: Record<string, string> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  ß: 'ss',
};

/**
 * Macht aus der laufenden Eingabe eine zulässige Schreibweise.
 *
 * UNTERSCHIED ZUR SERVERFASSUNG, mit Absicht: Ein Bindestrich am ENDE bleibt
 * stehen. Würde er sofort entfernt, ließe sich „musterverein-ostend" gar nicht
 * tippen — nach jedem Bindestrich verschwände er wieder. Unzulässig ist er
 * trotzdem: `subdomainFormatfehler` meldet ihn, und der Server normalisiert
 * beim Anlegen ohnehin noch einmal.
 */
export function normalizeSubdomain(input: string): string {
  let replaced = '';
  for (const character of input.toLowerCase()) {
    replaced += UMLAUTS[character] ?? character;
  }
  return replaced
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-/, '')
    .slice(0, SUBDOMAIN_MAX);
}

/** Warum das Format unzulässig ist — oder `null`, wenn es das nicht ist. */
export function subdomainFormatError(value: string): string | null {
  if (value.length === 0) return null;
  if (value.length > SUBDOMAIN_MAX) {
    return t('common.subdomain.text', { SUBDOMAIN_MAX });
  }
  if (!SUBDOMAIN_PATTERN.test(value)) {
    return t('common.subdomain.text2');
  }
  return null;
}
