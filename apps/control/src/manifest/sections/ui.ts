import {
  sectionAsObject,
  optionalTextField,
  type ErrorList,
} from '../validation';

export interface UiManifest {
  /**
   * Optionaler Override des Anzeigenamens in der Oberfläche. Ohne Angabe gilt
   * `product.name` (EINE Namensquelle); null = kein Override.
   */
  productName: string | null;
  /** URL oder Pfad des Logos; null = kein Logo. */
  logoUrl: string | null;
}

export const UI_PRESET: UiManifest = {
  productName: null,
  logoUrl: null,
};

export function checkUi(raw: unknown, error: ErrorList): UiManifest {
  const o = sectionAsObject(raw, 'ui', error);
  const productName = optionalTextField(o, 'productName', 'ui', error);
  if (productName !== null && productName.trim() === '') {
    error.push('ui.productName: darf nicht leer sein');
  }
  const logoUrl = optionalTextField(o, 'logoUrl', 'ui', error);
  if (logoUrl !== null && !/^(https?:\/\/|\/)/.test(logoUrl)) {
    error.push('ui.logoUrl: muss mit http://, https:// oder "/" beginnen');
  }
  return {
    productName,
    logoUrl,
  };
}
