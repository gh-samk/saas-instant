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
});
