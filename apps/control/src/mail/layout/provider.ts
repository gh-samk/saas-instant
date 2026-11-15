/**
 * Die Anbieterkennung — seit dem 12.09.2026 aus dem GEMEINSAMEN Mailrahmen
 * (`@saas-instant/shared`, `mail-rahmen.ts`): Dieselben Pflichtangaben stehen in
 * jeder Mail der Verwaltung UND jeder Kundeninstanz. Sie sind NICHT mehr im
 * Quelltext, sondern kommen aus dem Manifest (`mail`), übernommen beim Start
 * durch `mail-marke.ts`.
 *
 * DIE ABSCHRIFT BLEIBT ABGESICHERT: `haus-fusszeile.spec.ts` hält die Fusszeile
 * gegen die übernommene Marke.
 */
import { mailBrand } from '@saas-instant/shared';

/** Die Anbieterzeilen der Fusszeile (Manifest: `mail.footer`, `mail.imprint`). */
export function houseDetails(): readonly string[] {
  return mailBrand().details;
}

/** Die Verweise der Fusszeile (Manifest: `mail.legalLinks`). */
export function houseLinks(): readonly { text: string; url: string }[] {
  return mailBrand().links;
}

/** Die Webseite des Betreibers (Manifest: `mail.websiteUrl`) oder null. */
export function houseUrl(): string | null {
  return mailBrand().url;
}
