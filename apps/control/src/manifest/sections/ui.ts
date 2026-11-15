import {
  sectionAsObject,
  optionalTextField,
  textField,
  type ErrorList,
} from '../validation';

export interface UiManifest {
  productName: string;
  /** URL oder Pfad des Logos; null = kein Logo. */
  logoUrl: string | null;
}

export const UI_PRESET: UiManifest = {
  productName: 'saas-instant',
  logoUrl: null,
};

export function checkUi(raw: unknown, error: ErrorList): UiManifest {
  const o = sectionAsObject(raw, 'ui', error);
  const logoUrl = optionalTextField(o, 'logoUrl', 'ui', error);
  if (logoUrl !== null && !/^(https?:\/\/|\/)/.test(logoUrl)) {
    error.push('ui.logoUrl: muss mit http://, https:// oder "/" beginnen');
  }
  return {
    productName: textField(o, 'productName', 'ui', UI_PRESET.productName, error, { notEmpty: true }),
    logoUrl,
  };
}
