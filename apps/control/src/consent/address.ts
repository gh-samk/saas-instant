import { createHash, randomBytes } from 'crypto';

/**
 * NORMALISIERUNG DER ADRESSE — die Voraussetzung dafür, dass die Sperrliste
 * eine ist.
 *
 * `Einwilligung.email` ist eindeutig (ein Eintrag je Adresse). Ohne
 * Normalisierung wären „Anna@Example.com", „anna@example.com" und
 * „ anna@example.com " drei Adressen: Wer sich abgemeldet hat, bekäme nach dem
 * nächsten Import mit anderer Schreibweise wieder Post — genau der Fall, gegen
 * den der Sperreintrag steht.
 *
 * BEWUSST NUR Rand-Leerzeichen und Kleinschreibung. Keine Punkte im lokalen
 * Teil entfernen, keine „+…"-Zusätze abschneiden: Das sind bei Gmail und nur
 * bei Gmail dieselbe Adresse; als allgemeine Regel angewandt legte es fremde
 * Postfächer zusammen. Der lokale Teil gehört dem empfangenden Server.
 */
export function normalizeAddress(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Grobe Plausibilitätsprüfung. Die eigentliche Validierung macht
 * `class-validator` am DTO; das hier ist die zweite Linie für alles, was
 * nicht über ein DTO hereinkommt (CLI, Import, Test).
 */
export function isPlausibleAddress(raw: string): boolean {
  const address = normalizeAddress(raw);
  if (address.length < 6 || address.length > 254) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(address);
}

/**
 * Ein Token für Bestätigung oder Abmeldung.
 *
 * 32 Zufallsbytes, base64url — 256 Bit. Es steht in einer URL, die in fremden
 * Postfächern, Weiterleitungen und Spamfiltern liegt und die JEDER, der sie
 * hat, ohne Anmeldung benutzen kann. Kürzer darf es deshalb nicht sein, und
 * geraten werden darf es erst recht nicht.
 *
 * `base64url` steht in Node 20 zur Verfügung und ist ohne Prozentkodierung
 * URL-sicher — anders als `base64`, dessen `+` und `/` in einem Pfadsegment
 * umgeschrieben würden.
 */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Schlüssel einer BERATUNGSSPERRE auf einer Adresse.
 *
 * `SELECT … FOR UPDATE` hilft nur bei einer Zeile, die es schon gibt. Beim
 * ersten Eintragen gibt es keine — zwei gleichzeitige Formularabsendungen
 * derselben Adresse sähen beide „kennen wir nicht" und liefen beide in ein
 * `create`. Die zweite scheiterte am eindeutigen Index, und die Absenderin
 * bekäme einen Serverfehler auf ein Formular, das nichts falsch gemacht hat.
 *
 * `pg_advisory_xact_lock` sperrt stattdessen den SCHLÜSSEL, nicht die Zeile:
 * für die Dauer der Transaktion und nur für genau diese Adresse. Dasselbe
 * Verfahren benutzt `OeffentlichService.legeAn` beim Anlegen einer
 * Organisation.
 *
 * DER PRÄFIX IST WICHTIG: Ohne ihn hätte dieselbe Adresse in beiden Vorgängen
 * denselben Schlüssel, und eine Newsletter-Eintragung blockierte eine
 * gleichzeitige Demo-Anfrage derselben Person ohne jeden Grund.
 */
export function lockKeyForAddress(email: string): bigint {
  const sum = createHash('sha256')
    .update(`einwilligung:${normalizeAddress(email)}`, 'utf8')
    .digest('hex');
  return BigInt.asIntN(64, BigInt(`0x${sum.slice(0, 16)}`));
}
