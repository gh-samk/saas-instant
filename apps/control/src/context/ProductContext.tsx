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
  /** Produktname aus dem Manifest (`ui.productName`). */
  productName: string;
  /** Logo-URL aus dem Manifest, oder null = kein Logo. */
  logoUrl: string | null;
}

/** Neutraler Ersatz, solange `/api/public-config` nicht geantwortet hat. */
export const PRODUCT_DEFAULT: ProductValues = {
  productName: 'saas-instant',
  logoUrl: null,
};

const Context = createContext<ProductValues>(PRODUCT_DEFAULT);

/**
 * Holt Produktname und Logo einmalig von `GET /api/public-config` (ohne
 * Sitzung erreichbar). Scheitert der Abruf, bleibt die neutrale Vorgabe
 * stehen — der Name ist Dekoration, kein Grund, die Oberfläche zu sperren.
 */
export function ProductProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [values, setValues] = useState<ProductValues>(PRODUCT_DEFAULT);

  useEffect(() => {
    let active = true;
    apiFetch<{ productName?: unknown; logoUrl?: unknown } | null>(
      '/api/public-config',
    )
      .then((response) => {
        if (!active || !response) return;
        const name =
          typeof response.productName === 'string' && response.productName !== ''
            ? response.productName
            : PRODUCT_DEFAULT.productName;
        const logo =
          typeof response.logoUrl === 'string' && response.logoUrl !== ''
            ? response.logoUrl
            : null;
        setValues({ productName: name, logoUrl: logo });
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
