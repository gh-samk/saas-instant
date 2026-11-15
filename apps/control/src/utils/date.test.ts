import { describe, expect, it } from 'vitest';
import { dateInText, formatDate } from './date';

describe('formatDatum', () => {
  it('formatiert einen reinen Kalendertag', () => {
    expect(formatDate('2026-08-29')).toBe('29.08.2026');
  });

  it('reduziert einen Zeitstempel auf den lokalen Kalendertag', () => {
    const timestamp = new Date(2026, 7, 29, 14, 30).toISOString();
    expect(formatDate(timestamp)).toBe('29.08.2026');
  });

  it('wirft bei einem unlesbaren Wert statt still etwas auszugeben', () => {
    expect(() => formatDate('kein Datum')).toThrow();
  });
});

describe('datumImText', () => {
  it('schreibt ISO-Tage in Servertexten auf dd.mm.yyyy um', () => {
    // Vier Aufgabenquellen der Etappe 3 setzen den Kalendertag direkt in ihre
    // Begründung ein. Das Datumsformat der Anwendung gilt trotzdem.
    expect(
      dateInText('Der Abgleich konnte am 2026-08-31 keine Anwendung finden.'),
    ).toBe('Der Abgleich konnte am 31.08.2026 keine Anwendung finden.');
    expect(dateInText('Von 2026-01-02 bis 2026-03-04.')).toBe(
      'Von 02.01.2026 bis 04.03.2026.',
    );
  });

  it('lässt Text ohne Datum und unmögliche Daten unangetastet', () => {
    expect(dateInText('Seit 22 Tagen keine neue Sicherung.')).toBe(
      'Seit 22 Tagen keine neue Sicherung.',
    );
    expect(dateInText('Stand 2026-13-40.')).toBe('Stand 2026-13-40.');
  });
});
