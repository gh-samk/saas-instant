import { describe, expect, it } from 'vitest';
import { dueNotice, daysUntil } from './due-date';

describe('tageBis', () => {
  it('zählt ganze Kalendertage in beide Richtungen', () => {
    expect(daysUntil('2026-08-31', '2026-08-31')).toBe(0);
    expect(daysUntil('2026-09-01', '2026-08-31')).toBe(1);
    expect(daysUntil('2026-08-30', '2026-08-31')).toBe(-1);
    expect(daysUntil('2026-09-30', '2026-08-31')).toBe(30);
  });

  it('zählt über die Sommerzeitumstellung hinweg richtig', () => {
    // 25.10.2026 ist der Rückstelltag in Europa/Berlin — der lokale Tag hat
    // 25 Stunden. Gerechnet wird über UTC-Mitternacht, deshalb bleibt es 1.
    expect(daysUntil('2026-10-26', '2026-10-25')).toBe(1);
    expect(daysUntil('2026-11-01', '2026-10-24')).toBe(8);
  });

  it('weist ein unmögliches Datum ab, statt still danebenzurechnen', () => {
    expect(() => daysUntil('2026-02-30', '2026-08-31')).toThrow();
  });
});

describe('faelligkeitsHinweis', () => {
  it('nennt Überfälliges beim Wort — Farbe ist nie das alleinige Signal', () => {
    expect(dueNotice('2026-08-30', '2026-08-31')).toBe(
      'Seit 1 Tag überfällig',
    );
    expect(dueNotice('2026-08-19', '2026-08-31')).toBe(
      'Seit 12 Tagen überfällig',
    );
  });

  it('formuliert Heute, Morgen und die nähere Zukunft', () => {
    expect(dueNotice('2026-08-31', '2026-08-31')).toBe('Heute fällig');
    expect(dueNotice('2026-09-01', '2026-08-31')).toBe(
      'Morgen fällig',
    );
    expect(dueNotice('2026-09-12', '2026-08-31')).toBe('In 12 Tagen');
  });
});
