import { createContext, createElement, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { defaultLocale, dictionaries, locales } from './locales';
import type { Dictionary, Locale } from './locales';

export type { Locale } from './locales';
export type Params = Record<string, string | number>;
export type TFunction = (key: string, params?: Params) => string;

const STORAGE_KEY = 'saas-instant.locale';

/** Ersetzt `{name}`-Platzhalter; unbekannte Platzhalter bleiben stehen. */
function interpolate(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/**
 * Übersetzt einen Schlüssel. Ist er unbekannt, kommt der Schlüssel selbst
 * zurück (sichtbar statt leer). Plural: mit `params.count` wird zuerst
 * `<key>_one` bzw. `<key>_other` gesucht, sonst `<key>`.
 */
export function translate(locale: Locale, key: string, params?: Params): string {
  const dict: Dictionary = dictionaries[locale] ?? dictionaries[defaultLocale];
  let text = dict[key];
  if (text === undefined && params && typeof params.count === 'number') {
    text = dict[`${key}_${params.count === 1 ? 'one' : 'other'}`];
  }
  return interpolate(text ?? key, params);
}

/** Globale Kurzform in Standardsprache, für Code außerhalb von React. */
export function t(key: string, params?: Params): string {
  return translate(currentLocale, key, params);
}

let currentLocale: Locale = defaultLocale;

/** Gespeicherte oder vom Browser gemeldete Sprache; sonst die Standardsprache. */
export function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && (locales as string[]).includes(stored)) return stored as Locale;
  } catch {
    // localStorage nicht verfügbar — weiter mit Navigator.
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language?.slice(0, 2) : '';
  return (locales as string[]).includes(nav) ? (nav as Locale) : defaultLocale;
}

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: TFunction;
}

const I18nContext = createContext<I18nValue>({
  locale: defaultLocale,
  setLocale: () => undefined,
  t: (key, params) => translate(defaultLocale, key, params),
});

export function I18nProvider({
  children,
  locale: initial,
}: {
  children: ReactNode;
  locale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(initial ?? detectLocale());
  currentLocale = locale;
  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale: (next) => {
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch {
          // Speichern ist nur eine Bequemlichkeit.
        }
        setLocaleState(next);
      },
      t: (key, params) => translate(locale, key, params),
    }),
    [locale],
  );
  return createElement(I18nContext.Provider, { value }, children);
}

export function useT(): TFunction {
  return useContext(I18nContext).t;
}

export function useLocale() {
  const { locale, setLocale } = useContext(I18nContext);
  return { locale, setLocale };
}
