import { describe, expect, it } from 'vitest';
import {
  IssuerProfile,
  LEGAL_FORMS,
  LegalForm,
  buildIssuerBlocks,
  contrastRatio,
  emptyIssuerProfile,
  validateAccentColor,
  validateIssuerProfile,
} from './issuer-profile';

const base = (form: LegalForm, over: Partial<IssuerProfile>): IssuerProfile => ({
  ...emptyIssuerProfile(form),
  street: 'Musterstraße 1',
  postalCode: '99999',
  city: 'Musterstadt',
  iban: 'DE89 3704 0044 0532 0130 00',
  vatId: 'DE136695976',
  taxNumber: '12/345/67890',
  ...over,
});

const fields = (p: IssuerProfile): string[] =>
  validateIssuerProfile(p).map((i) => i.field).sort();

const person = 'Erika Mustermann';
const TAX = ['USt-IdNr. DE136695976', 'St.-Nr. 12/345/67890'];

describe('Rechtsformen', () => {
  it('kennt alle acht Formen', () => {
    expect(Object.keys(LEGAL_FORMS)).toHaveLength(8);
  });

  it('Einzelunternehmen (nicht eingetragen)', () => {
    const p = base('einzelunternehmen', { name: 'Erika Mustermann', ownerName: person });
    expect(validateIssuerProfile(p)).toEqual([]);
    expect(buildIssuerBlocks(p).legalLines).toEqual(['Inhaber: Erika Mustermann', ...TAX]);
    expect(fields(base('einzelunternehmen', {}))).toEqual(['name', 'ownerName']);
  });

  it('Einzelunternehmen e.K.', () => {
    const p = base('einzelunternehmen', {
      registered: true, name: 'Mustermann e.K.', ownerName: person,
      seat: 'Berlin', registerCourt: 'Charlottenburg', registerNumber: 'HRA 1234',
    });
    expect(validateIssuerProfile(p)).toEqual([]);
    expect(buildIssuerBlocks(p).legalLines).toEqual([
      'Sitz Berlin', 'Amtsgericht Charlottenburg, HRA 1234', ...TAX,
    ]);
    expect(fields({ ...p, seat: '', registerCourt: '', registerNumber: '' })).toEqual(
      ['registerCourt', 'registerNumber', 'seat'],
    );
    expect(validateIssuerProfile({ ...p, name: 'Mustermann' })[0]!.code).toBe('legalFormSuffix');
  });

  it('GbR und eGbR', () => {
    const p = base('gbr', { name: 'Muster GbR', partners: ['Erika Mustermann', 'Max Muster'] });
    expect(validateIssuerProfile(p)).toEqual([]);
    expect(buildIssuerBlocks(p).legalLines).toEqual(['Gesellschafter: Erika Mustermann, Max Muster', ...TAX]);
    expect(fields({ ...p, partners: [] })).toEqual(['partners']);
    const e = { ...p, registered: true, name: 'Muster eGbR', seat: 'Musterstadt', registerCourt: 'Berlin', registerNumber: 'GsR 12' };
    expect(validateIssuerProfile(e)).toEqual([]);
    expect(buildIssuerBlocks(e).legalLines).toEqual([
      'Gesellschafter: Erika Mustermann, Max Muster', 'GbR-Register Berlin, GsR 12', ...TAX,
    ]);
    expect(fields({ ...e, name: 'Muster GbR' })).toEqual(['name']);
  });

  it('OHG', () => {
    const p = base('ohg', { name: 'Muster OHG', seat: 'Hamburg', registerCourt: 'Hamburg', registerNumber: 'HRA 5' });
    expect(validateIssuerProfile(p)).toEqual([]);
    expect(buildIssuerBlocks(p).legalLines).toEqual(['Sitz Hamburg', 'Amtsgericht Hamburg, HRA 5', ...TAX]);
    expect(fields(base('ohg', { name: 'Muster OHG' }))).toEqual(['registerCourt', 'registerNumber', 'seat']);
  });

  it('GmbH', () => {
    const p = base('gmbh', {
      name: 'Muster GmbH', seat: 'Musterstadt', registerCourt: 'Musterstadt', registerNumber: 'HRB 99999',
      managingPersons: ['Erika Mustermann', 'Max Muster'],
    });
    expect(validateIssuerProfile(p)).toEqual([]);
    expect(buildIssuerBlocks(p).legalLines).toEqual([
      'Amtsgericht Musterstadt, HRB 99999', 'Geschäftsführung Erika Mustermann, Max Muster',
      ...TAX,
    ]);
    expect(fields(base('gmbh', { name: 'Muster GmbH' }))).toEqual(
      ['managingPersons', 'registerCourt', 'registerNumber', 'seat'],
    );
  });

  it('UG', () => {
    const p = base('ug', {
      name: 'Muster UG (haftungsbeschränkt)', seat: 'Köln', registerCourt: 'Köln', registerNumber: 'HRB 7',
      managingPersons: [person],
    });
    expect(validateIssuerProfile(p)).toEqual([]);
    expect(buildIssuerBlocks(p).legalLines).toEqual([
      'Sitz Köln', 'Amtsgericht Köln, HRB 7', 'Geschäftsführung Erika Mustermann', ...TAX,
    ]);
    expect(validateIssuerProfile({ ...p, name: 'Muster UG' })[0]!.code).toBe('legalFormSuffix');
    expect(fields({ ...p, name: 'Muster Unternehmergesellschaft (haftungsbeschränkt)' })).toEqual([]);
  });

  it('GmbH & Co. KG', () => {
    const p = base('gmbh_co_kg', {
      name: 'Beispiel GmbH & Co. KG', seat: 'Musterstadt', registerCourt: 'Musterstadt', registerNumber: 'HRA 99999',
      generalPartner: {
        name: 'Beispiel Verwaltungs GmbH', seat: 'Musterstadt', registerCourt: 'Musterstadt',
        registerNumber: 'HRB 99999', managingDirectors: [person],
      },
      accountHolder: 'Beispiel Verwaltungs GmbH', bankName: 'Beispielbank', bic: 'COBADEFFXXX',
      phone: '+49 30 1234567', email: 'rechnung@example.com', web: 'www.example.com',
    });
    expect(validateIssuerProfile(p)).toEqual([]);
    const b = buildIssuerBlocks(p);
    expect(b.companyLines).toEqual(['Beispiel GmbH & Co. KG', 'Musterstraße 1', '99999 Musterstadt']);
    expect(b.contactLines).toEqual(['Tel. +49 30 1234567', 'rechnung@example.com', 'www.example.com']);
    expect(b.bankLines).toEqual([
      'Beispielbank', 'Kontoinhaber: Beispiel Verwaltungs GmbH', 'IBAN DE89 3704 0044 0532 0130 00', 'BIC COBADEFFXXX',
    ]);
    expect(b.legalLines).toEqual([
      'Amtsgericht Musterstadt, HRA 99999', 'Persönlich haftende Gesellschafterin:',
      'Beispiel Verwaltungs GmbH, Sitz Musterstadt', 'Amtsgericht Musterstadt, HRB 99999',
      'Geschäftsführung Erika Mustermann', ...TAX,
    ]);
    const bad = base('gmbh_co_kg', { name: 'Beispiel GmbH & Co. KG' });
    expect(fields(bad)).toEqual([
      'generalPartner.managingDirectors', 'generalPartner.name', 'generalPartner.registerCourt',
      'generalPartner.registerNumber', 'generalPartner.seat', 'registerCourt', 'registerNumber', 'seat',
    ]);
  });

  it('eG', () => {
    const p = base('eg', {
      name: 'Muster eG', seat: 'Bonn', registerCourt: 'Bonn', registerNumber: 'GnR 12',
      managingPersons: [person],
    });
    expect(validateIssuerProfile(p)).toEqual([]);
    expect(buildIssuerBlocks(p).legalLines).toEqual([
      'Sitz Bonn', 'Genossenschaftsregister Bonn, GnR 12', 'Vorstand Erika Mustermann',
      ...TAX,
    ]);
    expect(fields(base('eg', { name: 'Muster eG' }))).toEqual(['managingPersons', 'registerCourt', 'registerNumber', 'seat']);
  });

  it('e.V.', () => {
    const p = base('ev', {
      name: 'Muster e.V.', seat: 'Jena', registerCourt: 'Jena', registerNumber: 'VR 3', managingPersons: [person],
    });
    expect(validateIssuerProfile(p)).toEqual([]);
    expect(buildIssuerBlocks(p).legalLines).toEqual([
      'Sitz Jena', 'Amtsgericht Jena, VR 3', 'Vorstand Erika Mustermann', ...TAX,
    ]);
    expect(fields(base('ev', { name: 'Muster' }))).toEqual(
      ['managingPersons', 'name', 'registerCourt', 'registerNumber', 'seat'].sort(),
    );
  });
});

describe('Formatprüfungen', () => {
  const ok = base('einzelunternehmen', { name: 'Erika Mustermann', ownerName: person });

  it('Steuerangabe: eine von beiden genügt', () => {
    expect(validateIssuerProfile({ ...ok, vatId: '' })).toEqual([]);
    expect(validateIssuerProfile({ ...ok, vatId: '', taxNumber: '' })).toMatchObject([{ field: 'vatId', code: 'missing' }]);
  });
  it('IBAN mod-97', () => {
    expect(validateIssuerProfile({ ...ok, iban: 'DE89 3704 0044 0532 0130 01' })).toMatchObject([{ field: 'iban', code: 'iban' }]);
  });
  it('USt-IdNr.', () => {
    expect(validateIssuerProfile({ ...ok, vatId: '123' })).toMatchObject([{ field: 'vatId', code: 'vatId' }]);
  });
  it('Personennamen', () => {
    for (const n of ['Mustermann', 'E. Mustermann', 'E Mustermann']) {
      expect(validateIssuerProfile({ ...ok, ownerName: n })).toMatchObject([{ field: 'ownerName', code: 'personName' }]);
    }
  });
  it('Registernummer braucht Ziffern', () => {
    const p = base('ohg', { name: 'X OHG', seat: 'A', registerCourt: 'A', registerNumber: 'HRA' });
    expect(validateIssuerProfile(p)).toMatchObject([{ field: 'registerNumber', code: 'format' }]);
  });
  it('Kontoinhaber gleich Firma wird nicht doppelt gedruckt', () => {
    const p = { ...ok, accountHolder: 'erika  mustermann' };
    expect(buildIssuerBlocks(p).bankLines).toEqual(['IBAN DE89 3704 0044 0532 0130 00']);
  });
});

describe('Akzentfarbe', () => {
  it('Kontrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });
  it('akzeptiert das Standardblau', () => {
    const r = validateAccentColor('#0369A1');
    expect(r.valid).toBe(true);
    expect(contrastRatio(r.accentOnDark!, '#0f1318')).toBeGreaterThanOrEqual(4.5);
  });
  it('lehnt Format und zu geringen Kontrast ab', () => {
    expect(validateAccentColor('0369A1')).toEqual({ valid: false, error: 'format' });
    expect(validateAccentColor('#ffcc00')).toMatchObject({ valid: false, error: 'contrast' });
  });
  it('hellt dunkle Farben für den Dunkelmodus auf', () => {
    const r = validateAccentColor('#1e3a5f');
    expect(r.valid).toBe(true);
    expect(contrastRatio(r.accentOnDark!, '#0f1318')).toBeGreaterThanOrEqual(4.5);
  });
});
