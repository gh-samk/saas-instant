import {
  replace,
  foundPlaceholder,
  openPlaceholder,
  unknownPlaceholder,
} from './placeholder';

describe('Platzhalter', () => {
  it('findet sie in Fundreihenfolge und ohne Dubletten', () => {
    expect(foundPlaceholder('Hallo {{organisation}}, {{organisation}}!'))
      .toEqual(['organisation']);
  });

  it('erkennt nur die enge Schreibweise als Platzhalter', () => {
    expect(foundPlaceholder('{{ organisation }} {{Organisation}} {org}'))
      .toEqual([]);
  });

  it('lässt Standardplatzhalter immer zu', () => {
    expect(unknownPlaceholder('{{organisation}} {{abmeldelink}}', [])).toEqual(
      [],
    );
  });

  it('meldet, was niemand füllen kann', () => {
    expect(unknownPlaceholder('Hallo {{vorname}}', ['nachname'])).toEqual([
      'vorname',
    ]);
  });

  it('setzt bekannte Werte ein und lässt unbekannte stehen', () => {
    const text = replace('Hallo {{organisation}}, {{fehlt}}', {
      organisation: 'Beispielorganisation',
    });
    expect(text).toBe('Hallo Beispielorganisation, {{fehlt}}');
    expect(openPlaceholder(text)).toEqual(['fehlt']);
  });

  /**
   * Der Grund, warum es `offenePlatzhalter` überhaupt gibt: „Hallo {{name}},"
   * in tausend Postfächern ist kein Schönheitsfehler, sondern der sichtbarste
   * Beleg dafür, dass ein Versand nicht geprüft wurde.
   */
  it('meldet nach vollständigem Einsetzen nichts mehr', () => {
    const text = replace('Hallo {{organisation}}', { organisation: 'X' });
    expect(openPlaceholder(text)).toEqual([]);
  });
});
