import { describe, expect, it } from 'vitest';
import { cumulativePaidCent } from './payment';

describe('cumulativePaidCent', () => {
  it('schickt bei „voll bezahlt“ die ganze Rechnungssumme, auch nach einer Teilzahlung', () => {
    expect(cumulativePaidCent('full', 58310, 0, '')).toBe(58310);
    expect(cumulativePaidCent('full', 58310, 10000, '999')).toBe(58310);
  });

  it('addiert bei einer Teilzahlung die neue Rate auf das bisher Bezahlte', () => {
    expect(cumulativePaidCent('partial', 58310, 0, '100')).toBe(10000);
    expect(cumulativePaidCent('partial', 58310, 10000, '50,10')).toBe(15010);
  });

  it('rechnet ohne Gleitkommareste', () => {
    expect(cumulativePaidCent('partial', 100000, 1, '19.99')).toBe(2000);
  });

  it('weist unlesbare und nicht positive Eingaben ab', () => {
    expect(cumulativePaidCent('partial', 58310, 0, '')).toBeNull();
    expect(cumulativePaidCent('partial', 58310, 0, 'abc')).toBeNull();
    expect(cumulativePaidCent('partial', 58310, 0, '0')).toBeNull();
    expect(cumulativePaidCent('partial', 58310, 0, '-5')).toBeNull();
    expect(cumulativePaidCent('partial', 58310, 0, '1.234')).toBeNull();
  });

  // [M13] Berichtigen: der Betrag ist der neue Gesamtstand, auch 0.
  it('setzt bei „berichtigen“ den eingetippten Gesamtstand, auch 0', () => {
    expect(cumulativePaidCent('correct', 58310, 58310, '100')).toBe(10000);
    expect(cumulativePaidCent('correct', 58310, 58310, '0')).toBe(0);
    expect(cumulativePaidCent('correct', 58310, 10000, '0,00')).toBe(0);
    expect(cumulativePaidCent('correct', 58310, 10000, '583,10')).toBe(58310);
  });

  it('weist beim Berichtigen unlesbare und negative Eingaben ab', () => {
    expect(cumulativePaidCent('correct', 58310, 10000, '')).toBeNull();
    expect(cumulativePaidCent('correct', 58310, 10000, 'abc')).toBeNull();
    expect(cumulativePaidCent('correct', 58310, 10000, '-1')).toBeNull();
    expect(cumulativePaidCent('correct', 58310, 10000, '1.234')).toBeNull();
  });
});
