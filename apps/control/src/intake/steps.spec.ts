import { checkPaymentPairingInForm, Steps } from './steps';

/**
 * Monatlich geht nur per Lastschrift — die Regel der Webseite, serverseitig.
 * Im Formular fehlte sie bis zum 07.09.2026: „Monatlich" und „Überweisung"
 * liessen sich zusammen waehlen und kamen bis zum Absenden durch.
 */
describe('Monatlich geht nur per Lastschrift', () => {
  it('weist monatlich + Ueberweisung ab und sagt beide Auswege', () => {
    const error = checkPaymentPairingInForm('monthly', 'bank_transfer');
    expect(error).not.toBeNull();
    expect(error!.field).toBe('paymentMethod');
    expect(error!.message).toContain('Lastschrift');
    expect(error!.message).toContain('jährlich');
  });

  it('laesst monatlich + Lastschrift durch', () => {
    expect(checkPaymentPairingInForm('monthly', 'direct_debit')).toBeNull();
  });

  it('laesst jeden anderen Rhythmus mit Ueberweisung durch', () => {
    expect(checkPaymentPairingInForm('yearly', 'bank_transfer')).toBeNull();
    expect(checkPaymentPairingInForm('half_yearly', 'bank_transfer')).toBeNull();
  });

  it('urteilt NICHT, solange eine der beiden Angaben fehlt', () => {
    // Sonst stuende „Monatlich geht nur per Lastschrift" als Antwort auf eine
    // Frage da, die noch niemand beantwortet hat.
    expect(checkPaymentPairingInForm('monthly', undefined)).toBeNull();
    expect(checkPaymentPairingInForm(undefined, 'bank_transfer')).toBeNull();
    expect(checkPaymentPairingInForm('monthly', '')).toBeNull();
  });
});

/** Der Haken des Mandats stand ohne jede Beschriftung da. */
describe('Jedes Feld sagt, was es will', () => {
  it('hat nirgends eine leere Bezeichnung', () => {
    for (const step of Steps) {
      for (const field of step.fields) {
        expect(field.label.trim()).not.toBe('');
      }
    }
  });
});
