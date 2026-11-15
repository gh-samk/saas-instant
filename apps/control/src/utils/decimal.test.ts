import { describe, expect, it } from 'vitest';
import { decimalFieldValue, formatQuantity, formatPercent } from './decimal';

describe('formatMenge', () => {
  it('macht aus dem gefährlichsten String der Rechnung eine ehrliche Eins', () => {
    // "1.000" ist im Vertrag EINS. Deutsch gelesen wäre es TAUSEND — und es
    // steht neben einem Einzelpreis und einem Gesamtbetrag.
    expect(formatQuantity('1.000')).toBe('1');
  });

  it('kürzt bedeutungslose Nachkommanullen, behält bedeutsame', () => {
    expect(formatQuantity('2.500')).toBe('2,5');
    expect(formatQuantity('0.125')).toBe('0,125');
    expect(formatQuantity('12')).toBe('12');
  });

  it('trägt das Vorzeichen einer Stornoposition durch', () => {
    expect(formatQuantity('-1.000')).toBe('-1');
  });

  it('reicht Unlesbares durch, statt eine Zahl zu behaupten', () => {
    expect(formatQuantity('keine Zahl')).toBe('keine Zahl');
  });
});

describe('formatProzent', () => {
  it('schreibt den Steuersatz deutsch und mit Zeichen', () => {
    expect(formatPercent('19.00').replace(/ /g, ' ')).toBe('19 %');
    expect(formatPercent('7.50').replace(/ /g, ' ')).toBe('7,5 %');
    expect(formatPercent('0.00').replace(/ /g, ' ')).toBe('0 %');
  });

  it('reicht Unlesbares durch', () => {
    expect(formatPercent('—')).toBe('—');
  });
});

describe('dezimalFeldwert', () => {
  it('behält den Punkt und wirft die Nullen des Datenbankformats weg', () => {
    expect(decimalFieldValue('1.000')).toBe('1');
    expect(decimalFieldValue('2.500')).toBe('2.5');
    expect(decimalFieldValue('19.00')).toBe('19');
    expect(decimalFieldValue('-1.000')).toBe('-1');
  });

  it('reicht Unlesbares durch', () => {
    expect(decimalFieldValue('abc')).toBe('abc');
  });
});
