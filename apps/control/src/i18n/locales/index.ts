/**
 * Führt alle Wörterbücher einer Sprache zusammen.
 *
 * Jede Datei `locales/<sprache>/<namespace>.ts` exportiert per `default` ein
 * flaches Objekt `{ schluessel: 'Text' }`. Der Dateiname ist der Namespace;
 * der volle Schlüssel lautet `<namespace>.<schluessel>`. Neue Namespaces
 * müssen nirgends registriert werden (kein gemeinsamer Konfliktpunkt).
 */
export type Dictionary = Record<string, string>;
export type Locale = 'de';

function merge(modules: Record<string, { default: Record<string, string> }>): Dictionary {
  const result: Dictionary = {};
  for (const [path, mod] of Object.entries(modules)) {
    const namespace = path.split('/').pop()!.replace(/\.ts$/, '');
    for (const [key, value] of Object.entries(mod.default)) {
      result[`${namespace}.${key}`] = value;
    }
  }
  return result;
}

export const dictionaries: Record<Locale, Dictionary> = {
  de: merge(import.meta.glob('./de/*.ts', { eager: true })),
};

export const locales = Object.keys(dictionaries) as Locale[];
export const defaultLocale: Locale = 'de';
