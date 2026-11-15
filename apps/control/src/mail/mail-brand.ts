import { setMailBrand } from '@saas-instant/shared';
import type { ManifestService } from '../manifest/manifest.service';
import { registerMailManifest } from './sender';

/**
 * Überträgt Produktname und Mail-Abschnitt des Manifests in den Mailrahmen
 * (`@saas-instant/shared`) und in die Absenderauflösung (`absender.ts`).
 *
 * Aufgerufen beim Start durch das `MailModule`. Die Anbieterzeilen sind der
 * `imprint`-Text des Manifests, eine Zeile je Zeilenumbruch; die
 * `footer`-Zeilen stehen davor.
 */
export function applyMailBrand(manifest: ManifestService): void {
  const mail = manifest.mail;
  const rows = (text: string | null): string[] =>
    (text ?? '')
      .split('\n')
      .map((z) => z.trim())
      .filter((z) => z !== '');
  registerMailManifest(mail);
  setMailBrand({
    name: manifest.product.name,
    details: [...rows(mail.footer), ...rows(mail.imprint)],
    url: mail.websiteUrl,
    links: mail.legalLinks,
  });
}

/**
 * Anzeigename der Verwaltung: hängt ' Verwaltung' nur an, wenn der Name nicht
 * schon auf 'Verwaltung' endet (sonst 'SAAS Verwaltung Verwaltung').
 */
export function displayName(name: string, joiner: ' ' | '-' = ' '): string {
  const trimmed = name.trim();
  return /(^|[\s-])Verwaltung$/i.test(trimmed) ? trimmed : `${trimmed}${joiner}Verwaltung`;
}
