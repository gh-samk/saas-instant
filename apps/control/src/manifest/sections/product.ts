import { sectionAsObject, textField, type ErrorList } from '../validation';

export interface ProductManifest {
  /** Anzeigename des Produkts (EINZIGE Namensquelle für UI, Mails, Rechnungen, Portal). */
  name: string;
  /** Kurzname für Dateinamen, Bezeichner und Präfixe (a-z, 0-9, Bindestrich). */
  slug: string;
}

export const PRODUCT_PRESET: ProductManifest = {
  name: 'SAAS Verwaltung',
  slug: 'saas-instant',
};

/** Platzhaltername des Beispielmanifests (install.sh ohne --name): gilt nicht als angebunden. */
export const EXAMPLE_PRODUCT_NAME = 'Mein Produkt';

/**
 * „Angebunden" heißt: Das Manifest benennt eine Software (Name weicht vom
 * Preset und vom Beispielnamen ab). `checkProduct` stellt sicher, dass dann auch ein Slug gesetzt ist.
 */
export function isBound(product: ProductManifest): boolean {
  const name = product.name.trim();
  return (
    name !== '' &&
    name !== PRODUCT_PRESET.name &&
    name !== EXAMPLE_PRODUCT_NAME &&
    product.slug !== ''
  );
}

export function checkProduct(raw: unknown, error: ErrorList): ProductManifest {
  const o = sectionAsObject(raw, 'product', error);
  const nameSet = o['name'] !== undefined && o['name'] !== null;
  const slugSet = o['slug'] !== undefined && o['slug'] !== null;
  if (nameSet && !slugSet) {
    error.push(
      'product.slug: fehlt - ist product.name gesetzt, muss auch product.slug gesetzt sein ' +
        '(die Verwaltung gehört zu genau einer Software und wird an diesen Slug gebunden)',
    );
  }
  return {
    name: textField(o, 'name', 'product', PRODUCT_PRESET.name, error, { notEmpty: true }),
    slug: textField(o, 'slug', 'product', PRODUCT_PRESET.slug, error, {
      pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/,
      patternHint: 'nur Kleinbuchstaben, Ziffern und Bindestriche (z. B. "mein-produkt")',
    }),
  };
}
