import { describe, expect, it } from 'vitest';
import { translate } from './index';
import { dictionaries } from './locales';

describe('i18n', () => {
  it('ersetzt Platzhalter', () => {
    expect(translate('de', 'unbekannt.hallo {name}', { name: 'Welt' })).toBe(
      'unbekannt.hallo Welt',
    );
  });
  it('fällt auf den Schlüssel zurück', () => {
    expect(translate('de', 'gibt.es.nicht')).toBe('gibt.es.nicht');
  });
  it('wählt die Pluralform', () => {
    expect(translate('de', 'common.itemCount', { count: 1 })).toBe('1 Eintrag');
    expect(translate('de', 'common.itemCount', { count: 3 })).toBe('3 Einträge');
  });
  it('führt Namespaces zu Schlüsseln zusammen', () => {
    expect(dictionaries.de['common.save']).toBe('Speichern');
  });
});
