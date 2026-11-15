import { Prisma } from '.prisma/control-client';
import {
  missingDetails,
  isComplete,
  checkDirectDebitComplete,
  type ToCheck,
} from './completeness';

/** Eine Organisation, an der wirklich nichts steht. */
const Empty: ToCheck = {
  name: '',
  legalForm: null,
  street: null,
  houseNumber: null,
  postalCode: null,
  city: null,
  contactName: null,
  contactEmail: null,
  contactPhone: null,
  paymentInterval: null,
  paymentMethod: null,
  iban: null,
  accountHolder: null,
  sepaMandateGrantedAt: null,
};

/** Eine, an der alles steht — ohne Lastschrift. */
const Full: ToCheck = {
  name: 'Solawi Rheintal eG',
  legalForm: 'eingetragene Genossenschaft',
  street: 'Hauptstraße',
  houseNumber: '4',
  postalCode: '79576',
  city: 'Weil am Rhein',
  contactName: 'Lena Brandt',
  contactEmail: 'contact@example.com',
  contactPhone: '+49 7621 123456',
  paymentInterval: 'yearly',
  paymentMethod: 'bank_transfer',
  iban: null,
  accountHolder: null,
  sepaMandateGrantedAt: null,
};

describe('Was einer Organisation zum laufenden Pilot fehlt', () => {
  it('nennt bei einer leeren Organisation jedes Pflichtfeld', () => {
    const missing = missingDetails(Empty);
    expect(missing.map((f) => f.field)).toContain('name');
    expect(missing.map((f) => f.field)).toContain('paymentInterval');
    expect(isComplete(Empty)).toBe(false);
  });

  it('haelt eine Ueberweiserin ohne Bankdaten fuer vollstaendig', () => {
    // Wer jaehrlich ueberweist, braucht kein Mandat. Eine IBAN von ihm zu
    // verlangen waere eine Angabe ohne Zweck — und Bankdaten ohne Zweck sind
    // Bankdaten zu viel.
    expect(missingDetails(Full)).toEqual([]);
    expect(isComplete(Full)).toBe(true);
  });

  it('verlangt bei Lastschrift IBAN, Kontoinhaberin und Mandat', () => {
    const directDebit: ToCheck = {
      ...Full,
      paymentInterval: 'monthly',
      paymentMethod: 'direct_debit',
    };
    expect(missingDetails(directDebit).map((f) => f.field).sort()).toEqual([
      'accountHolder',
      'iban',
      'sepaMandateGrantedAt',
    ]);
  });

  it('ist mit Mandat auch bei Lastschrift vollstaendig', () => {
    expect(
      isComplete({
        ...Full,
        paymentInterval: 'monthly',
        paymentMethod: 'direct_debit',
        iban: 'DE02120300000000202051',
        accountHolder: 'Solawi Rheintal eG',
        sepaMandateGrantedAt: new Date(),
      }),
    ).toBe(true);
  });

  it('behandelt Leerzeichen wie nicht ausgefuellt', () => {
    expect(missingDetails({ ...Full, city: '   ' }).map((f) => f.field)).toEqual(
      ['city'],
    );
  });

  it('gibt zu jedem Feld eine Bezeichnung fuer Menschen', () => {
    for (const entry of missingDetails(Empty)) {
      expect(entry.label.length).toBeGreaterThan(2);
      expect(entry.label).not.toBe(entry.field);
    }
  });

  /**
   * =======================================================================
   * JEDER GENANNTE FELDNAME MUSS AM MODELL EXISTIEREN
   * =======================================================================
   *
   * Die Namen stehen hier als Zeichenketten und wandern ins Formular, in die
   * Fehlerzuordnung und in die Karte der Verwaltung. Eine Umbenennung im
   * Schema wuerde sie sonst still ins Leere laufen lassen — das Formular
   * verlangte ein Feld, das es nicht mehr gibt.
   */
  it('nennt nur Felder, die es am Modell wirklich gibt', () => {
    const atModel = Object.keys(Prisma.CompanyScalarFieldEnum);
    for (const entry of missingDetails(Empty)) {
      expect(atModel).toContain(entry.field);
    }
    for (const entry of checkDirectDebitComplete({
      ...Empty,
      paymentMethod: 'direct_debit',
    })) {
      expect(atModel).toContain(entry.field);
    }
  });
});

describe('checkDirectDebitComplete', () => {
  it('schweigt, solange nicht per Lastschrift gezahlt wird', () => {
    // Die Regel gehoert NICHT in `checkPaymentPairing`: Dort waere ein halb
    // ausgefuellter Vertrag ploetzlich ein Fehler, obwohl er am Anfang der
    // Normalfall ist.
    expect(checkDirectDebitComplete(Full)).toEqual([]);
    expect(checkDirectDebitComplete(Empty)).toEqual([]);
  });

  it('meldet bei Lastschrift genau die fehlenden Bankangaben', () => {
    expect(
      checkDirectDebitComplete({
        ...Full,
        paymentMethod: 'direct_debit',
        iban: 'DE02120300000000202051',
      }).map((f) => f.field),
    ).toEqual(['accountHolder', 'sepaMandateGrantedAt']);
  });
});
