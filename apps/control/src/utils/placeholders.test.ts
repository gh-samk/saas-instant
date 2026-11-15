import { describe, expect, it } from 'vitest';
import {
  foundPlaceholders,
  placeholdersFromInput,
  unknownPlaceholders,
} from './placeholders';

/**
 * Die Fälle sind absichtlich dieselben wie in
 * `src/broadcast/platzhalter.spec.ts`: Läuft die Anzeigefassung dem Server
 * davon, fällt es genau hier auf und nicht erst an einer Vorlage, die schon
 * unterwegs ist.
 */
describe('gefundenePlatzhalter', () => {
  it('findet die enge Form und nichts anderes', () => {
    expect(
      foundPlaceholders('Hallo {{organisation}}, hier {{name}}.'),
    ).toEqual(['organisation', 'name']);
  });

  it('lässt Leerraum, Grossbuchstaben und einfache Klammern aussen vor', () => {
    expect(foundPlaceholders('{{ name }} {{Name}} {name} {{na-me}}')).toEqual(
      [],
    );
  });

  it('zählt eine Dublette nur einmal', () => {
    expect(foundPlaceholders('{{a}} {{a}} {{b}}')).toEqual(['a', 'b']);
  });
});

describe('unbekanntePlatzhalter', () => {
  it('meldet, was nirgends erklärt ist', () => {
    expect(
      unknownPlaceholders('{{organisation}} {{betrag}}', [
        'organisation',
        'abmeldelink',
      ]),
    ).toEqual(['betrag']);
  });

  it('meldet nichts, wenn alles erklärt ist', () => {
    expect(
      unknownPlaceholders('{{organisation}} {{betrag}}', [
        'organisation',
        'abmeldelink',
        'betrag',
      ]),
    ).toEqual([]);
  });
});

describe('platzhalterAusEingabe', () => {
  it('trennt an Komma und Leerraum und wirft Dubletten weg', () => {
    expect(placeholdersFromInput('name, betrag  name')).toEqual([
      'name',
      'betrag',
    ]);
  });

  it('entfernt herüberkopierte Klammern und macht klein', () => {
    expect(placeholdersFromInput('{{Name}}, {{betrag}}')).toEqual([
      'name',
      'betrag',
    ]);
  });

  it('ergibt aus einer leeren Eingabe eine leere Liste', () => {
    expect(placeholdersFromInput('   ')).toEqual([]);
  });
});
