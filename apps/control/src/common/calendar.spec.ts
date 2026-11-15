import { datePlusMonths, dayReadable } from './calendar';

describe('datePlusMonths', () => {
  it('addiert Monate im einfachen Fall', () => {
    expect(datePlusMonths('2026-03-12', 7)).toBe('2026-10-12');
  });

  it('rechnet über den Jahreswechsel', () => {
    expect(datePlusMonths('2026-08-31', 7)).toBe('2027-03-31');
  });

  it('kürzt auf den letzten Tag des Zielmonats', () => {
    // 31.07. plus sieben Monate gibt es nicht — der 28.02. ist gemeint,
    // nicht der 03.03.
    expect(datePlusMonths('2026-07-31', 7)).toBe('2027-02-28');
  });

  it('kennt den 29. Februar im Schaltjahr', () => {
    expect(datePlusMonths('2027-07-31', 7)).toBe('2028-02-29');
  });

  it('rechnet mit negativen Werten zurück', () => {
    expect(datePlusMonths('2026-08-31', -24)).toBe('2024-08-31');
    expect(datePlusMonths('2026-01-15', -7)).toBe('2025-06-15');
  });

  it('lässt ein unmögliches Datum nicht durch', () => {
    expect(() => datePlusMonths('2026-02-30', 1)).toThrow();
    expect(() => datePlusMonths('31.08.2026', 1)).toThrow();
  });
});

describe('dayReadable', () => {
  it('schreibt den Tag so, wie er in einer Notiz steht', () => {
    expect(dayReadable('2027-03-12')).toBe('12.03.2027');
  });

  it('weist einen Zeitstempel ab — Notizen tragen kein ISO-Datum', () => {
    expect(() => dayReadable('2027-03-12T10:00:00.000Z')).toThrow();
  });
});
