import { describe, expect, it } from 'vitest';
import { ApiError, errorText } from './api-client';
import { issueLine, isRawServerText, validationIssues } from './validation-errors';
import { dictionaries } from '../i18n/locales';

function validation(messages: string[]): ApiError {
  return new ApiError({ code: 'HTTP_400', message: messages[0] ?? '', detail: messages }, 400);
}

describe('validationIssues', () => {
  it('bildet lines.0.unit auf „Posten 1, Einheit" ab, deutsch und ohne Rohtext', () => {
    const [issue] = validationIssues(
      validation(['lines.0.unit must be shorter than or equal to 3 characters']),
    );
    expect(issue).toMatchObject({ path: 'lines.0.unit', field: 'unit', index: 0, label: 'Posten 1, Einheit' });
    expect(issueLine(issue!)).toBe('Posten 1, Einheit: Höchstens 3 Zeichen erlaubt.');
  });

  it('zählt Posten ab 1 und kennt die Bezeichnungen der Rechnungsfelder', () => {
    const issues = validationIssues(
      validation([
        'lines.2.unitPriceNetCent must not be greater than 99999999',
        'lines.2.quantity must be a number conforming to the specified constraints',
        'invoiceDate must be a valid ISO 8601 date string',
      ]),
    );
    expect(issues.map(issueLine)).toEqual([
      'Posten 3, Einzelpreis: Höchstens 99999999 erlaubt.',
      'Posten 3, Menge: Bitte gib eine Zahl ein.',
      'Rechnungsdatum: Bitte gib ein gültiges Datum ein.',
    ]);
  });

  it('übernimmt eigene deutsche Meldungen der DTOs unverändert, ohne Feldbezug', () => {
    const [issue] = validationIssues(validation(['Die Bezeichnung des Postens fehlt.']));
    expect(issue).toEqual({
      path: null, field: null, index: null, label: null, message: 'Die Bezeichnung des Postens fehlt.',
    });
  });

  it('gibt für unbekannte Regeln und Felder einen deutschen Standardsatz, nie den Rohtext', () => {
    const [issue] = validationIssues(validation(['foo.bar must be something strange']));
    expect(issueLine(issue!)).toBe('Eine Angabe: Bitte prüfe diese Angabe.');
    expect(issueLine(validationIssues(validation(['property evil should not exist']))[0]!)).toBe(
      'Eine Angabe: Diese Angabe ist hier nicht vorgesehen.',
    );
  });

  it('liefert nichts für Fehler, die keine Eingabeprüfung sind', () => {
    expect(validationIssues(new Error('x'))).toEqual([]);
    expect(validationIssues(new ApiError({ code: 'HTTP_500', message: 'x', detail: ['a b'] }, 500))).toEqual([]);
    expect(validationIssues(new ApiError({ code: 'HTTP_400', message: 'x' }, 400))).toEqual([]);
    expect(validationIssues(new ApiError({ code: 'invoice_incomplete', message: 'Ja.', detail: ['x y'] }, 400))).toEqual([]);
  });

  it('übersetzt auch Wertelisten-Fehler und hat die Texte im Wörterbuch', () => {
    const dict = dictionaries.de;
    const source = Object.keys(dict).filter((k) => k.startsWith('common.validation.'));
    expect(source.length).toBeGreaterThan(20);
    const issues = validationIssues(
      validation(['lines.0.taxCategory must be one of the following values: S, Z']),
    );
    expect(issueLine(issues[0]!)).toBe('Posten 1, Steuerkategorie: Dieser Wert ist nicht erlaubt. Wähle einen Wert aus der Liste.');
  });
});

describe('errorText mit Prüfmeldungen und Rohtexten', () => {
  it('zeigt bei einer Meldung Feld und Satz, bei mehreren die Anzahl', () => {
    expect(
      errorText(validation(['lines.0.unit must be shorter than or equal to 3 characters']), 'Fehler'),
    ).toBe('Posten 1, Einheit: Höchstens 3 Zeichen erlaubt.');
    expect(
      errorText(
        validation(['lines.0.unit must be shorter than or equal to 3 characters', 'dueDate must be a valid ISO 8601 date string']),
        'Fehler',
      ),
    ).toBe('2 Angaben prüfen');
  });

  it('ersetzt englische Rahmentexte durch den deutschen Ersatztext', () => {
    expect(errorText(new ApiError({ code: 'HTTP_500', message: 'Internal server error' }, 500), 'Das ging schief.')).toBe('Das ging schief.');
    expect(errorText(new ApiError({ code: 'HTTP_404', message: 'Cannot GET /api/x' }, 404), 'Nicht gefunden.')).toBe('Nicht gefunden.');
  });

  it('lässt fachliche deutsche Meldungen des Servers stehen', () => {
    expect(errorText(new ApiError({ code: 'x', message: 'Die Rechnung ist schon festgeschrieben.' }, 409), 'Fehler')).toBe(
      'Die Rechnung ist schon festgeschrieben.',
    );
  });

  it('erkennt rohe Texte', () => {
    expect(isRawServerText('Bad Request')).toBe(true);
    expect(isRawServerText('lines.0.unit must be longer')).toBe(true);
    expect(isRawServerText('')).toBe(true);
    expect(isRawServerText('Die Menge fehlt.')).toBe(false);
  });
});
