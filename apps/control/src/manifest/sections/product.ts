import {
  sectionAsObject,
  textField,
  type ErrorList,
} from '../validation';

export interface ProductManifest {
  /** Anzeigename des Produkts. */
  name: string;
  /** Kurzname für Dateinamen, Bezeichner und Präfixe (a-z, 0-9, Bindestrich). */
  slug: string;
}

export const PRODUCT_PRESET: ProductManifest = {
  name: 'saas-instant',
  slug: 'saas-instant',
};

export function checkProduct(raw: unknown, error: ErrorList): ProductManifest {
  const o = sectionAsObject(raw, 'product', error);
  return {
    name: textField(o, 'name', 'product', PRODUCT_PRESET.name, error, { notEmpty: true }),
    slug: textField(o, 'slug', 'product', PRODUCT_PRESET.slug, error, {
      pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/,
      patternHint: 'nur Kleinbuchstaben, Ziffern und Bindestriche (z. B. "mein-produkt")',
    }),
  };
}
