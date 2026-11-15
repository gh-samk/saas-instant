import { ISSUER_PRESETS } from './document/issuer.config';
import {
  issuerSnapshot,
  recipientSnapshot,
  missingMandatoryDetails,
  type CompanyForSnapshot,
} from './invoice.snapshot';

const EMPTY: CompanyForSnapshot = {
  name: 'Kollektiv Grünspecht e. V.',
  street: null,
  houseNumber: null,
  postalCode: null,
  city: null,
  country: null,
  billingName: null,
  billingStreet: null,
  billingHouseNumber: null,
  billingPostalCode: null,
  billingCity: null,
  billingCountry: null,
  billingEmail: null,
  contactEmail: null,
};

const COMPLETE: CompanyForSnapshot = {
  ...EMPTY,
  street: 'Ziegelgasse',
  houseNumber: '14',
  postalCode: '99423',
  city: 'Weimar',
  country: 'Deutschland',
  contactEmail: 'vorstand@gruenspecht-weimar.example.com',
};

describe('recipientSnapshot', () => {
  it('nimmt die Hausanschrift, wenn es keine Rechnungsadresse gibt', () => {
    const snapshot = recipientSnapshot(COMPLETE);
    expect(snapshot.recipientName).toBe('Kollektiv Grünspecht e. V.');
    expect(snapshot.recipientAddress).toBe(
      'Ziegelgasse 14\n99423 Weimar\nDeutschland',
    );
    expect(snapshot.recipientEmail).toBe(
      'vorstand@gruenspecht-weimar.example.com',
    );
  });

  /**
   * DIE RECHNUNGSADRESSE STICHT ALS GANZES.
   *
   * Wer eine abweichende Rechnungsadresse pflegt, will nicht, dass einzelne
   * Felder aus der Hausanschrift dazwischenrutschen — sonst entstünde eine
   * Anschrift, die es nirgends gibt.
   */
  it('nimmt die Rechnungsadresse vollständig, sobald es eine gibt', () => {
    const snapshot = recipientSnapshot({
      ...COMPLETE,
      billingName: 'Grünspecht e. V. — Buchhaltung',
      billingStreet: 'Postfach',
      billingHouseNumber: '112',
      billingPostalCode: '99401',
      billingCity: 'Weimar',
      billingCountry: 'Deutschland',
    });
    expect(snapshot.recipientName).toBe('Grünspecht e. V. — Buchhaltung');
    expect(snapshot.recipientAddress).toBe(
      'Postfach 112\n99401 Weimar\nDeutschland',
    );
    // KEINE Vermischung: „Ziegelgasse" taucht nirgends auf.
    expect(snapshot.recipientAddress).not.toContain('Ziegelgasse');
  });

  it('bevorzugt die Rechnungs-E-Mail vor der Ansprechpartnerin', () => {
    expect(
      recipientSnapshot({
        ...COMPLETE,
        billingEmail: 'buchhaltung@gruenspecht-weimar.example.com',
      }).recipientEmail,
    ).toBe('buchhaltung@gruenspecht-weimar.example.com');
  });
});

describe('missingMandatoryDetails (§ 14 UStG, § 125a HGB)', () => {
  const issuer = issuerSnapshot(ISSUER_PRESETS);

  it('beanstandet nichts an einer vollständigen Rechnung', () => {
    expect(
      missingMandatoryDetails({
        ...recipientSnapshot(COMPLETE),
        ...issuer,
        linesCount: 1,
      }),
    ).toEqual([]);
  });

  /**
   * DER FALL, WEGEN DEM ES DIESE PRÜFUNG GIBT.
   *
   * Eine Organisation ohne Anschrift lässt sich anlegen — Etappe 2 verlangt
   * dort nichts. Ein BELEG ohne Anschrift der Empfängerin ist dagegen
   * unbrauchbar, und das fiele erst bei der Betriebsprüfung auf, wenn sich
   * nichts mehr ändern lässt.
   */
  it('beanstandet eine fehlende Empfängeranschrift', () => {
    const missing = missingMandatoryDetails({
      ...recipientSnapshot(EMPTY),
      ...issuer,
      linesCount: 1,
    });
    expect(missing.join(' ')).toContain('Anschrift der Rechnungsempfängerin');
  });

  it('beanstandet eine Anschrift, die nur aus einem Ort besteht', () => {
    const missing = missingMandatoryDetails({
      ...recipientSnapshot({ ...EMPTY, city: 'Weimar' }),
      ...issuer,
      linesCount: 1,
    });
    expect(missing.join(' ')).toContain('Vollständige Anschrift');
  });

  it('beanstandet eine fehlende USt-IdNr. der Ausstellerin', () => {
    const missing = missingMandatoryDetails({
      ...recipientSnapshot(COMPLETE),
      ...issuer,
      issuerVatId: null,
      linesCount: 1,
    });
    expect(missing).toContain('Umsatzsteuer-Identifikationsnummer');
  });

  it('beanstandet fehlende Registerangaben nach § 125a HGB', () => {
    const missing = missingMandatoryDetails({
      ...recipientSnapshot(COMPLETE),
      ...issuer,
      issuerCommercialRegisterA: null,
      issuerGeneralPartnerCommercialRegisterB: null,
      linesCount: 1,
    });
    expect(missing).toContain('Handelsregisternummer der KG');
    expect(missing).toContain('Handelsregisternummer der Komplementärin');
  });

  it('verlangt nichts zur Komplementärin, wenn keine genannt ist', () => {
    const missing = missingMandatoryDetails({
      ...recipientSnapshot(COMPLETE),
      ...issuer,
      issuerGeneralPartner: null,
      issuerGeneralPartnerSeat: null,
      issuerGeneralPartnerRegisterCourt: null,
      issuerGeneralPartnerCommercialRegisterB: null,
      issuerManagingDirector: null,
      linesCount: 1,
    });
    expect(missing.filter((m) => m.includes('Komplementärin'))).toEqual([]);
  });

  it('beanstandet eine Rechnung ohne Posten', () => {
    const missing = missingMandatoryDetails({
      ...recipientSnapshot(COMPLETE),
      ...issuer,
      linesCount: 0,
    });
    expect(missing).toContain('Mindestens ein Rechnungsposten');
  });
});

describe('issuerSnapshot', () => {
  it('trägt alle Angaben, die § 125a HGB verlangt', () => {
    const s = issuerSnapshot(ISSUER_PRESETS);
    expect(s.issuerCompanyName).toContain('GmbH & Co KG');
    expect(s.issuerCommercialRegisterA).toBe(ISSUER_PRESETS.registerIdentifier);
    expect(s.issuerGeneralPartnerCommercialRegisterB).toBe(
      ISSUER_PRESETS.generalPartner.registerIdentifier,
    );
    expect(s.issuerManagingDirector).toContain(ISSUER_PRESETS.generalPartner.managingDirector[0]);
    expect(s.issuerBankDetails).toContain('IBAN');
  });
});

describe('E-Rechnung im Schnappschuss (Empfänger)', () => {
  it('nimmt standardmäßig `business` ohne Kennungen, E-Mail als elektronische Adresse', () => {
    const s = recipientSnapshot(COMPLETE);
    expect(s.recipientBuyerType).toBe('business');
    expect(s.recipientVatId).toBeNull();
    expect(s.recipientBuyerReference).toBeNull();
    expect(s.recipientElectronicAddress).toBe('vorstand@gruenspecht-weimar.example.com');
    expect(s.recipientElectronicAddressScheme).toBe('EM');
  });

  it('übernimmt USt-IdNr., Leitweg-ID und eigene elektronische Adresse samt Schema', () => {
    const s = recipientSnapshot({
      ...COMPLETE,
      buyerType: 'authority',
      vatId: ' DE811111111 ',
      buyerReference: '991-12345-67',
      electronicAddress: '991-12345-67',
      electronicAddressScheme: '0204',
    });
    expect(s).toMatchObject({
      recipientBuyerType: 'authority',
      recipientVatId: 'DE811111111',
      recipientBuyerReference: '991-12345-67',
      recipientElectronicAddress: '991-12345-67',
      recipientElectronicAddressScheme: '0204',
    });
    // Die E-Mail für den Versand bleibt davon unberührt.
    expect(s.recipientEmail).toBe('vorstand@gruenspecht-weimar.example.com');
  });

  it('erkennt eine E-Mail als elektronische Adresse auch ohne Schema (EM)', () => {
    const s = recipientSnapshot({ ...COMPLETE, electronicAddress: 'rechnung@amt.example.org' });
    expect(s.recipientElectronicAddressScheme).toBe('EM');
  });

  it('lässt die elektronische Adresse leer, wenn es weder Adresse noch E-Mail gibt', () => {
    const s = recipientSnapshot({ ...COMPLETE, contactEmail: null });
    expect(s.recipientElectronicAddress).toBeNull();
    expect(s.recipientElectronicAddressScheme).toBeNull();
  });
});

describe('E-Rechnung im Schnappschuss (Aussteller)', () => {
  const s = issuerSnapshot(ISSUER_PRESETS);

  it('friert Kontakt und Bank STRUKTURIERT ein', () => {
    expect(s.issuerContactName).toBe(ISSUER_PRESETS.contact.name);
    expect(s.issuerContactPhone).toBe(ISSUER_PRESETS.contact.phone);
    expect(s.issuerContactEmail).toBe(ISSUER_PRESETS.contact.email);
    expect(s.issuerIban).toBe(ISSUER_PRESETS.bank.iban);
    expect(s.issuerBic).toBe(ISSUER_PRESETS.bank.bic);
    expect(s.issuerBankName).toBe(ISSUER_PRESETS.bank.institution);
  });

  it('entfernt Leerzeichen aus der IBAN', () => {
    const spaced = issuerSnapshot({
      ...ISSUER_PRESETS,
      bank: { ...ISSUER_PRESETS.bank, iban: 'DE02 1203 0000 0000 2020 51' },
    });
    expect(spaced.issuerIban).toBe('DE02120300000000202051');
  });
});

describe('missingMandatoryDetails je Rechtsform und Käuferart', () => {
  const issuer = issuerSnapshot(ISSUER_PRESETS);
  const noRegister = {
    issuerSeat: null,
    issuerRegisterCourt: null,
    issuerCommercialRegisterA: null,
    issuerGeneralPartner: null,
    issuerGeneralPartnerSeat: null,
    issuerGeneralPartnerRegisterCourt: null,
    issuerGeneralPartnerCommercialRegisterB: null,
    issuerManagingDirector: null,
  };

  it('verlangt bei einer Gesellschaft Sitz, Gericht und Registernummer (Vorgabe)', () => {
    const base = { ...recipientSnapshot(COMPLETE), ...issuer, ...noRegister, linesCount: 1 };
    for (const legalForm of [undefined, 'company' as const]) {
      const missing = missingMandatoryDetails({ ...base, legalForm });
      expect(missing).toEqual(
        expect.arrayContaining([
          'Sitz der KG',
          'Registergericht der KG',
          'Handelsregisternummer der KG',
        ]),
      );
    }
  });

  it.each(['sole_proprietor', 'association'] as const)(
    'verlangt bei %s keine Register- und Sitzangaben',
    (legalForm) => {
      const missing = missingMandatoryDetails({
        ...recipientSnapshot(COMPLETE),
        ...issuer,
        ...noRegister,
        linesCount: 1,
        legalForm,
      });
      expect(missing).toEqual([]);
    },
  );

  it('verlangt auch bei Einzelunternehmen USt-IdNr., Anschrift und Bank', () => {
    const missing = missingMandatoryDetails({
      ...recipientSnapshot(COMPLETE),
      ...issuer,
      ...noRegister,
      issuerVatId: null,
      issuerBankDetails: null,
      linesCount: 1,
      legalForm: 'sole_proprietor',
    });
    expect(missing).toEqual(
      expect.arrayContaining(['Umsatzsteuer-Identifikationsnummer', 'Bankverbindung']),
    );
  });

  it('verlangt den Rückfrageweg der Ausstellerin (BR-DE-2)', () => {
    const missing = missingMandatoryDetails({
      ...recipientSnapshot(COMPLETE),
      ...issuer,
      issuerContactName: null,
      issuerContactPhone: ' ',
      issuerContactEmail: null,
      linesCount: 1,
    });
    expect(missing).toEqual(
      expect.arrayContaining([
        'Ansprechpartner der Ausstellerin',
        'Telefon der Ausstellerin',
        'E-Mail der Ausstellerin',
      ]),
    );
  });

  it('verlangt bei einer Behörde die Leitweg-ID, bei einem Unternehmen nicht', () => {
    const authority = recipientSnapshot({ ...COMPLETE, buyerType: 'authority' });
    expect(
      missingMandatoryDetails({ ...authority, ...issuer, linesCount: 1 }),
    ).toContain('Leitweg-ID der Behörde (Käuferreferenz)');
    expect(
      missingMandatoryDetails({
        ...recipientSnapshot({ ...COMPLETE, buyerType: 'authority', buyerReference: '991-1-1' }),
        ...issuer,
        linesCount: 1,
      }),
    ).toEqual([]);
    expect(
      missingMandatoryDetails({
        ...recipientSnapshot({ ...COMPLETE, buyerType: 'consumer' }),
        ...issuer,
        linesCount: 1,
      }),
    ).toEqual([]);
  });
});
