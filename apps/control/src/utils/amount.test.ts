import { describe, expect, it } from 'vitest';
import {
  centAsFieldValue,
  centFromInput,
  formatAmount,
  formatAmountCent,
} from './amount';

describe('formatBetrag', () => {
  it('formatiert die Dezimal-Zeichenkette des Servers als Euro-Betrag', () => {
    // Nicht-umbrechendes Leerzeichen vor dem Zeichen, wie Intl es setzt.
    expect(formatAmount('1234.50').replace(/ /g, ' ')).toBe('1.234,50 €');
    expect(formatAmount('0').replace(/ /g, ' ')).toBe('0,00 €');
  });

  it('reicht Unlesbares unverändert durch, statt „0,00 €" zu behaupten', () => {
    expect(formatAmount('keine Zahl')).toBe('keine Zahl');
  });
});

describe('formatBetragCent', () => {
  it('formatiert ganze Cent deutsch', () => {
    expect(formatAmountCent(123450).replace(/\u00a0/g, ' ')).toBe('1.234,50 €');
    expect(formatAmountCent(0).replace(/\u00a0/g, ' ')).toBe('0,00 €');
  });

  it('behält das Vorzeichen einer Stornoposition', () => {
    expect(formatAmountCent(-104125).replace(/\u00a0/g, ' ')).toBe(
      '-1.041,25 €',
    );
  });
});

describe('centAusEingabe', () => {
  it('zerlegt die Zeichenkette, statt über Gleitkomma zu multiplizieren', () => {
    // Number('19.99') * 100 ist 1998.9999999999998 — genau der Grund für die
    // Zerlegung.
    expect(centFromInput('19.99')).toBe(1999);
    expect(centFromInput('490')).toBe(49000);
    expect(centFromInput('0.1')).toBe(10);
    expect(centFromInput('-12.34')).toBe(-1234);
  });

  it('nimmt auch das Komma an, weil es sich deutsch von selbst eintippt', () => {
    expect(centFromInput('19,99')).toBe(1999);
  });

  it('meldet Unlesbares als null, statt still 0 zu behaupten', () => {
    expect(centFromInput('')).toBeNull();
    expect(centFromInput('abc')).toBeNull();
    expect(centFromInput('-')).toBeNull();
    // Drei Nachkommastellen sind keine Cent-Angabe: stillschweigend zu runden
    // hieße, einen anderen Betrag zu speichern als den eingetippten.
    expect(centFromInput('1.005')).toBeNull();
  });
});

describe('centAlsFeldwert', () => {
  it('liefert den Punktwert, den ein input[type=number] annimmt', () => {
    expect(centAsFieldValue(1999)).toBe('19.99');
    expect(centAsFieldValue(49000)).toBe('490.00');
    expect(centAsFieldValue(-1234)).toBe('-12.34');
  });
});
