import { setMailBrand, type MailBrand } from '@saas-instant/shared';

/**
 * Eine ausgedachte Marke für Tests. Alle Werte gehören zu reservierten
 * Beispieldomänen (`example.com`); nichts davon ist ein echter Anbieter.
 */
export const TEST_BRAND: MailBrand = {
  name: 'Beispielprodukt',
  details: [
    'Beispiel GmbH, Musterweg 1, 12345 Musterstadt',
    'Sitz Musterstadt · Amtsgericht Musterstadt HRB 0000',
    'Geschäftsführer: Erika Mustermann',
    'USt-IdNr. DE000000000 · Telefon +49 000 0000000 · hallo@example.com',
  ],
  url: 'https://example.com',
  links: [
    { text: 'example.com', url: 'https://example.com' },
    { text: 'Impressum', url: 'https://example.com/impressum' },
    { text: 'Datenschutz', url: 'https://example.com/datenschutz' },
    { text: 'AGB', url: 'https://example.com/agb' },
  ],
};

/** Setzt `TEST_MARKE` als gültige Marke des Mailrahmens. */
export function setTestBrand(): void {
  setMailBrand(TEST_BRAND);
}
