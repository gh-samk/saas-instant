import { describe, expect, it } from 'vitest';
import { emptyIssuerProfile, validateIssuerProfile } from '@saas-instant/shared';
import {
  LEGAL_FORM_ORDER,
  getPathValue,
  hasRegisterPrefix,
  inlineIssue,
  isPlausibleVatId,
  layoutRows,
  planFields,
  requiredPaths,
  sectionProgress,
  setPathValue,
} from './issuer-fields';

describe('Pflichtfelder je Rechtsform', () => {
  it('es gibt alle acht Rechtsformen', () => {
    expect([...LEGAL_FORM_ORDER].sort()).toEqual(
      ['eg', 'einzelunternehmen', 'ev', 'gbr', 'gmbh', 'gmbh_co_kg', 'ohg', 'ug'],
    );
  });

  for (const form of LEGAL_FORM_ORDER) {
    for (const registered of [false, true]) {
      it(`${form} (eingetragen: ${registered}) stimmt mit der Prüfung in shared überein`, () => {
        // Land leeren: die Vorgabe „Deutschland" würde es sonst nie als fehlend melden.
        const profile = { ...emptyIssuerProfile(form), registered, country: '' };
        const fromShared = validateIssuerProfile(profile)
          .filter((i) => i.code === 'missing' && i.field !== 'vatId')
          .map((i) => i.field)
          .sort();
        expect(requiredPaths(profile).sort()).toEqual(fromShared);
      });

      it(`${form} (eingetragen: ${registered}): jedes Pflichtfeld wird geplant, und nur diese`, () => {
        const profile = { ...emptyIssuerProfile(form), registered };
        const planned = planFields(profile)
          .flatMap((s) => s.fields)
          .filter((f) => f.required)
          .map((f) => f.path)
          .sort();
        expect(planned).toEqual(requiredPaths(profile).sort());
      });
    }
  }

  it('setzt und liest verschachtelte Pfade', () => {
    const p = setPathValue(emptyIssuerProfile('gmbh_co_kg'), 'generalPartner.seat', 'Berlin');
    expect(getPathValue(p, 'generalPartner.seat')).toBe('Berlin');
    expect(p.generalPartner.name).toBe('');
  });
});

describe('optionale Abschnitte', () => {
  for (const form of LEGAL_FORM_ORDER) {
    for (const registered of [false, true]) {
      it(`${form} (eingetragen: ${registered}): optional ist, was kein Pflichtfeld enthält (Steuer nie)`, () => {
        const profile = { ...emptyIssuerProfile(form), registered };
        for (const section of planFields(profile)) {
          const hasRequired = section.fields.some((f) => f.required);
          expect(section.optional).toBe(section.id !== 'tax' && !hasRequired);
        }
      });
    }
  }

  it('Kontakt ist immer optional, Bank (IBAN) und Steuer nie', () => {
    const sections = planFields(emptyIssuerProfile('gmbh'));
    const byId = Object.fromEntries(sections.map((s) => [s.id, s.optional]));
    expect(byId).toMatchObject({ contact: true, bank: false, tax: false, address: false });
  });

  it('zählt ausgefüllte Felder eines Abschnitts', () => {
    const profile = { ...emptyIssuerProfile('gmbh'), phone: '1', email: ' ', web: 'x.de' };
    const contact = planFields(profile).find((s) => s.id === 'contact')!;
    expect(sectionProgress(profile, contact)).toEqual({ filled: 2, total: 3 });
  });
});

describe('Zeilen', () => {
  it('fasst Sitz, Registergericht und Registernummer sowie IBAN und BIC zusammen', () => {
    const sections = planFields(emptyIssuerProfile('gmbh'));
    const rows = (id: string) =>
      layoutRows(sections.find((s) => s.id === id)!.fields).map((r) => r.map((f) => f.path));
    expect(rows('legal')[0]).toEqual(['seat', 'registerCourt', 'registerNumber']);
    expect(rows('bank')).toContainEqual(['iban', 'bic']);
    expect(rows('address')).toEqual([['street'], ['postalCode', 'city', 'country']]);
  });
});

describe('Prüfungen beim Verlassen', () => {
  it('USt-IdNr.: DE genau neun Ziffern, andere Länder grob', () => {
    expect(isPlausibleVatId('DE123456789')).toBe(true);
    expect(isPlausibleVatId('DE 123 456 789')).toBe(true);
    expect(isPlausibleVatId('DE12345678')).toBe(false);
    expect(isPlausibleVatId('DE12345678A')).toBe(false);
    expect(isPlausibleVatId('ATU12345678')).toBe(true);
    expect(isPlausibleVatId('12345')).toBe(false);
  });

  it('Registerpräfix je Rechtsform', () => {
    expect(hasRegisterPrefix('gmbh', 'registerNumber', 'HRB 12345')).toBe(true);
    expect(hasRegisterPrefix('gmbh', 'registerNumber', 'hrb12345')).toBe(true);
    expect(hasRegisterPrefix('gmbh', 'registerNumber', 'HRA 12345')).toBe(false);
    expect(hasRegisterPrefix('gmbh', 'registerNumber', '12345')).toBe(false);
    expect(hasRegisterPrefix('ev', 'registerNumber', 'VR 1234')).toBe(true);
    expect(hasRegisterPrefix('eg', 'registerNumber', 'GnR 12')).toBe(true);
    expect(hasRegisterPrefix('gmbh_co_kg', 'registerNumber', 'HRA 1')).toBe(true);
    expect(hasRegisterPrefix('gmbh_co_kg', 'generalPartner.registerNumber', 'HRB 1')).toBe(true);
    // Leere Werte und Werte ohne Ziffer meldet shared.
    expect(hasRegisterPrefix('gmbh', 'registerNumber', '')).toBe(true);
    expect(hasRegisterPrefix('gmbh', 'registerNumber', 'HRB')).toBe(true);
  });

  it('inlineIssue nutzt die IBAN-Prüfsumme aus shared', () => {
    const p = { ...emptyIssuerProfile('gmbh'), iban: 'DE89370400440532013001' };
    expect(inlineIssue(p, 'iban')).toEqual({ code: 'iban' });
    expect(inlineIssue({ ...p, iban: 'DE89 3704 0044 0532 0130 00' }, 'iban')).toBeNull();
    expect(inlineIssue({ ...p, iban: '' }, 'iban')).toBeNull();
  });
});
