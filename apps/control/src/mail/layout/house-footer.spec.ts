import { houseFooter, mailBrand, MAIL_BRAND_DEFAULT, setMailBrand } from '@saas-instant/shared';
import { ManifestService } from '../../manifest/manifest.service';
import { MAIL_PRESET } from '../../manifest/sections/mail';
import { PRODUCT_PRESET } from '../../manifest/sections/product';
import { registerMailManifest } from '../sender';
import { applyMailBrand } from '../mail-brand';
import { houseDetails, houseLinks, houseUrl } from './provider';

/**
 * ===========================================================================
 * DIE ANBIETERKENNUNG KOMMT AUS DEM MANIFEST UND NUR DARAUS
 * ===========================================================================
 *
 * Früher stand die Anbieterkennung als Konstante im Quelltext und wurde gegen
 * ein Impressum und die Rechnungsvorgaben des ursprünglichen Betreibers
 * gehalten. Beides entfällt: Das Produkt ist neutral, Name, Anbieterzeilen und
 * Verweise trägt der Betreiber im Manifest ein (`product.name`, `mail.footer`,
 * `mail.imprint`, `mail.websiteUrl`, `mail.legalLinks`).
 *
 * Geprüft wird, was das Produkt selbst zusichert: Ohne Eintrag bleibt die
 * Fusszeile neutral und leer, mit Eintrag steht jede Zeile und jeder Verweis
 * in der Fusszeile, und die Verweise sind absolut und ohne Parameter.
 */

function manifestWith(mail: Partial<typeof MAIL_PRESET>, name = PRODUCT_PRESET.name): ManifestService {
  return {
    mail: { ...MAIL_PRESET, ...mail },
    product: { ...PRODUCT_PRESET, name },
  } as unknown as ManifestService;
}

afterEach(() => {
  setMailBrand(MAIL_BRAND_DEFAULT);
  registerMailManifest(null);
});

describe('Ohne Eintrag im Manifest', () => {
  it('ist die Marke neutral: Produktname saas-instant, keine Zeilen, keine Verweise', () => {
    expect(mailBrand().name).toBe('saas-instant');
    expect(houseDetails()).toEqual([]);
    expect(houseLinks()).toEqual([]);
    expect(houseUrl()).toBeNull();
    expect(houseFooter().text).toBe('');
  });

  it('übernimmt auch die Vorgaben des Manifests neutral', () => {
    applyMailBrand(manifestWith({}));
    expect(houseDetails()).toEqual([]);
    expect(houseLinks()).toEqual([]);
  });
});

describe('Mit Eintrag im Manifest', () => {
  const mail = {
    footer: 'Automatisch versendet.\n',
    imprint: 'Beispiel GmbH, Musterweg 1, 12345 Musterstadt\n\nUSt-IdNr. DE000000000\n',
    websiteUrl: 'https://example.com',
    legalLinks: [
      { text: 'Impressum', url: 'https://example.com/impressum' },
      { text: 'Datenschutz', url: 'https://example.com/datenschutz' },
    ],
  };

  it('übernimmt Produktname, Zeilen (Fusszeile zuerst, Leerzeilen weg) und Verweise', () => {
    applyMailBrand(manifestWith(mail, 'Beispielprodukt'));
    expect(mailBrand().name).toBe('Beispielprodukt');
    expect(houseDetails()).toEqual([
      'Automatisch versendet.',
      'Beispiel GmbH, Musterweg 1, 12345 Musterstadt',
      'USt-IdNr. DE000000000',
    ]);
    expect(houseUrl()).toBe('https://example.com');
    expect(houseLinks()).toHaveLength(2);
  });

  it('setzt jede Zeile und jeden Verweis in beide Fassungen der Fusszeile', () => {
    applyMailBrand(manifestWith(mail));
    const f = houseFooter();
    for (const row of houseDetails()) {
      expect(f.html).toContain(row);
      expect(f.text).toContain(row);
    }
    for (const link of houseLinks()) {
      expect(f.html).toContain(`href="${link.url}"`);
      expect(f.text).toContain(link.url);
    }
  });

  /**
   * Ohne Parameter, und das ist keine Kosmetik: `rahmen.spec.ts` verbietet
   * jede Spur von `utm_`, `track` und Verwandtem. Eine Anbieterkennung ist
   * keine Messstelle.
   */
  it('hat absolute Verweise ohne Parameter und Umleitung', () => {
    applyMailBrand(manifestWith(mail));
    for (const link of houseLinks()) {
      expect(link.url).toMatch(/^https:\/\//);
      expect(link.url).not.toContain('?');
      expect(link.url).not.toContain('#');
    }
  });
});
