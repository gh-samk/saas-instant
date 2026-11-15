import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { apiFetch } from '../lib/api-client';
import { useT } from '../i18n';
import { publicLogoUrl } from '../lib/api';
import {
  DEFAULT_ACCENT,
  applyAccent,
  isHexColor,
  readRememberedAccent,
  rememberAccent,
} from '../lib/accent';

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
  /** Akzentfarbe der Oberfläche (Hell); Standard bis die Konfiguration da ist. */
  accentColor: string;
  /** Aufgehellte Akzentfarbe für den Dunkelmodus, oder null = aus der Farbe berechnet. */
  accentOnDark: string | null;
  /** Gibt es ein hochgeladenes Firmenlogo (`/api/public/logo`)? */
  hasLogo: boolean;
  /** Lädt die öffentliche Konfiguration neu, z. B. nach dem Speichern der Firmendaten. */
  refresh: () => void;
}

/** Name vor der Anbindung bzw. solange `/api/public-config` nicht geantwortet hat. */
export const PRODUCT_NAME_DEFAULT = 'SAAS Verwaltung';

/** „Verwaltung" als Untertitel ist überflüssig, wenn der Name schon so endet. */
export function showsBrand(name: string): boolean {
  return !/verwaltung\s*$/i.test(name.trim());
}

function valuesFor(
  name: string,
  logoUrl: string | null,
  bound: boolean,
  extra: Partial<Pick<ProductValues, 'accentColor' | 'accentOnDark' | 'hasLogo'>> = {},
): ProductValues {
  return {
    productName: name,
    logoUrl,
    bound,
    showBrand: showsBrand(name),
    accentColor: extra.accentColor ?? DEFAULT_ACCENT,
    accentOnDark: extra.accentOnDark ?? null,
    hasLogo: extra.hasLogo ?? false,
    refresh: () => undefined,
  };
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
  // Der Akzent hat einen eigenen Speicher und gilt auch ohne Anbindung.
  const accent = readRememberedAccent();
  const base = rememberedProduct();
  return { ...base, accentColor: accent.accentColor, accentOnDark: accent.accentOnDark };
}

function rememberedProduct(): ProductValues {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return PRODUCT_DEFAULT;
    const o = JSON.parse(raw) as {
      productName?: unknown;
      logoUrl?: unknown;
      bound?: unknown;
      hasLogo?: unknown;
    };
    if (o.bound !== true || typeof o.productName !== 'string' || o.productName === '') {
      return PRODUCT_DEFAULT;
    }
    const hasLogo = o.hasLogo === true;
    return valuesFor(
      o.productName,
      hasLogo
        ? publicLogoUrl()
        : typeof o.logoUrl === 'string' && o.logoUrl !== ''
          ? o.logoUrl
          : null,
      true,
      { hasLogo },
    );
  } catch {
    return PRODUCT_DEFAULT;
  }
}

function remember(v: ProductValues): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        productName: v.productName,
        // Eigenes Logo wird nicht als Adresse gemerkt, sondern als Flag.
        logoUrl: v.hasLogo ? null : v.logoUrl,
        bound: v.bound,
        hasLogo: v.hasLogo,
      }),
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
  const [reload, setReload] = useState(0);
  const [logoVersion, setLogoVersion] = useState<number | null>(null);

  const refresh = useCallback(() => {
    setLogoVersion(Date.now());
    setReload((n) => n + 1);
  }, []);

  useEffect(() => {
    let active = true;
    apiFetch<{
      productName?: unknown;
      logoUrl?: unknown;
      bound?: unknown;
      accentColor?: unknown;
      accentOnDark?: unknown;
      hasLogo?: unknown;
    } | null>('/api/public-config')
      .then((response) => {
        if (!active || !response) return;
        const bound = response.bound === true;
        const name =
          bound && typeof response.productName === 'string' && response.productName !== ''
            ? response.productName
            : PRODUCT_NAME_DEFAULT;
        const hasLogo = response.hasLogo === true;
        const logo = hasLogo
          ? publicLogoUrl(logoVersion)
          : typeof response.logoUrl === 'string' && response.logoUrl !== ''
            ? response.logoUrl
            : null;
        const accentColor = isHexColor(response.accentColor)
          ? response.accentColor.toLowerCase()
          : DEFAULT_ACCENT;
        const accentOnDark = isHexColor(response.accentOnDark)
          ? response.accentOnDark.toLowerCase()
          : null;
        const next = valuesFor(name, logo, bound, { accentColor, accentOnDark, hasLogo });
        setValues(next);
        remember(next);
        applyAccent(accentColor, accentOnDark);
        rememberAccent(accentColor, accentOnDark);
        document.title = t('common.productContext.text', { name });
      })
      .catch(() => {
        // Vorgabe behalten.
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  const value = useMemo(() => ({ ...values, refresh }), [values, refresh]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Ohne Provider (z. B. in Einzeltests) liefert der Hook die neutrale Vorgabe. */
export function useProduct(): ProductValues {
  return useContext(Context);
}
