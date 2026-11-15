import { ISSUER_PRESETS } from './document/issuer.config';
import { CreditorIdMissingError } from './invoice.errors';
import { preNotification } from './document.service';

/**
 * ===========================================================================
 * DIE VORABANKÜNDIGUNG — was das System zum Lastschrifteinzug beiträgt
 * ===========================================================================
 *
 * Der Einzug selbst läuft im Onlinebanking; das CRM erfasst das Mandat und
 * kündigt an. Diese Ankündigung ist der Teil, bei dem ein Fehler die Kundin
 * unmittelbar trifft:
 *
 * - Steht daneben „Zahlbar ohne Abzug bis zum …", überweist sie zusätzlich.
 *   Das Geld zurückzuholen macht mehr Arbeit als der ganze Vorgang wert ist.
 * - Fehlt die Gläubiger-ID, kann sie den Einzug bei ihrer Bank nicht
 *   zuordnen — und die Ankündigung ist wertlos.
 */

describe('Der Wortlaut', () => {
  const TEXT = preNotification(
    '2026-09-15',
    'SOZ-2026-0042',
    'DE98ZZZ09999999999',
  );

  it('nennt Datum, Mandatsreferenz und Gläubiger-ID', () => {
    expect(TEXT).toContain('15.09.2026');
    expect(TEXT).toContain('SOZ-2026-0042');
    expect(TEXT).toContain('DE98ZZZ09999999999');
  });

  it('SAGT AUSDRÜCKLICH, DASS NICHT ÜBERWIESEN WERDEN SOLL', () => {
    // Der Satz, der die Doppelzahlung verhindert.
    expect(TEXT).toContain('bitte nicht überweisen');
  });

  it('fordert nirgends zur Zahlung auf', () => {
    for (const forbidden of [/zahlbar/i, /überweisen Sie/i, /bitte zahlen/i]) {
      expect(TEXT).not.toMatch(forbidden);
    }
  });
});

describe('Ohne Gläubiger-ID gibt es keinen Beleg', () => {
  it.each([[''], ['   ']])(
    'wirft bei „%s", statt eine halbe Ankündigung zu drucken',
    (id) => {
      expect(() =>
        preNotification('2026-09-15', 'SOZ-2026-0042', id),
      ).toThrow(CreditorIdMissingError);
    },
  );

  it('nennt die Umgebungsvariable im Fehlertext', () => {
    // Ohne sie stünde in der Meldung „Dokument konnte nicht erzeugt werden",
    // und die Betreiberin suchte in den Container-Logs.
    try {
      preNotification('2026-09-15', 'SOZ-1', '');
      throw new Error('hätte werfen müssen');
    } catch (error) {
      expect(String((error as Error).message)).toContain(
        'CONTROL_INVOICE_CREDITOR_ID',
      );
    }
  });

  it('IST AB WERK HINTERLEGT — und zwar die echte, nachgerechnete', () => {
    // Sie steht in den Vorgaben wie IBAN und USt-IdNr: kein Geheimnis,
    // sondern eine Angabe, die auf jeder Ankündigung gedruckt wird. Dass die
    // Prüfziffern stimmen, rechnet `creditor-id.spec.ts` nach.
    expect(ISSUER_PRESETS.creditorId).toMatch(/^DE\d{2}[A-Z0-9]{3}\d{11}$/);
  });
});
