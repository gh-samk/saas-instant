import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { apiFetch } from '../lib/api-client';
import { useT } from '../i18n';

export interface ProductValues {
  /**
   * Anzeigename: bis zur Anbindung „SAAS Verwaltung", danach der Name der
   * Software (`product.name` bzw. Override `ui.productName`).
   */
  productName: string;
  /** Logo-URL aus dem Manifest, oder null = kein Logo. */
  logoUrl: string | null;
  /** Ist die Verwaltung an eine Software angebunden? */
  bound: boolean;
  /** Soll der Untertitel „Verwaltung" erscheinen? Nein, wenn der Name schon darauf endet. */
  showBrand: boolean;
}

/** Name vor der Anbindung bzw. solange `/api/public-config` nicht geantwortet hat. */
export const PRODUCT_NAME_DEFAULT = 'SAAS Verwaltung';

/** „Verwaltung" als Untertitel ist überflüssig, wenn der Name schon so endet. */
export function showsBrand(name: string): boolean {
  return !/verwaltung\s*$/i.test(name.trim());
}

function valuesFor(name: string, logoUrl: string | null, bound: boolean): ProductValues {
  return { productName: name, logoUrl, bound, showBrand: showsBrand(name) };
}

/** Neutraler Ersatz, solange `/api/public-config` nicht geantwortet hat. */
export const PRODUCT_DEFAULT: ProductValues = valuesFor(PRODUCT_NAME_DEFAULT, null, false);

const STORAGE_KEY = 'product-config';

/**
 * Der zuletzt bekannte Stand des Browsers verhindert das Flackern von
 * „SAAS Verwaltung" zum Softwarenamen beim erneuten Laden. Ohne Speicher
 * (privates Fenster, gesperrt) gilt die neutrale Vorgabe.
 */
function remembered(): ProductValues {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return PRODUCT_DEFAULT;
    const o = JSON.parse(raw) as { productName?: unknown; logoUrl?: unknown; bound?: unknown };
    if (o.bound !== true || typeof o.productName !== 'string' || o.productName === '') {
      return PRODUCT_DEFAULT;
    }
    return valuesFor(
      o.productName,
      typeof o.logoUrl === 'string' && o.logoUrl !== '' ? o.logoUrl : null,
      true,
    );
  } catch {
    return PRODUCT_DEFAULT;
  }
}

function remember(v: ProductValues): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ productName: v.productName, logoUrl: v.logoUrl, bound: v.bound }),
    );
  } catch {
    // Speicher nicht verfügbar: nur Komfort, kein Fehler.
  }
}

const Context = createContext<ProductValues>(PRODUCT_DEFAULT);

/**
 * Holt Produktname und Logo einmalig von `GET /api/public-config` (ohne
 * Sitzung erreichbar). Scheitert der Abruf, bleibt die neutrale Vorgabe
 * stehen — der Name ist Dekoration, kein Grund, die Oberfläche zu sperren.
 * Den Softwarenamen zeigt die Oberfläche erst, wenn die Verwaltung
 * angebunden ist (`bound`); vorher steht dort „SAAS Verwaltung".
 */
export function ProductProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [values, setValues] = useState<ProductValues>(remembered);

  useEffect(() => {
    let active = true;
    apiFetch<{ productName?: unknown; logoUrl?: unknown; bound?: unknown } | null>(
      '/api/public-config',
    )
      .then((response) => {
        if (!active || !response) return;
        const bound = response.bound === true;
        const name =
          bound && typeof response.productName === 'string' && response.productName !== ''
            ? response.productName
            : PRODUCT_NAME_DEFAULT;
        const logo =
          typeof response.logoUrl === 'string' && response.logoUrl !== ''
            ? response.logoUrl
            : null;
        const next = valuesFor(name, logo, bound);
        setValues(next);
        remember(next);
        document.title = t('common.productContext.text', { name });
      })
      .catch(() => {
        // Vorgabe behalten.
      });
    return () => {
      active = false;
    };
  }, []);

  return <Context.Provider value={values}>{children}</Context.Provider>;
}

/** Ohne Provider (z. B. in Einzeltests) liefert der Hook die neutrale Vorgabe. */
export function useProduct(): ProductValues {
  return useContext(Context);
}
