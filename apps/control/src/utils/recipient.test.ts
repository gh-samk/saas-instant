import { describe, expect, it } from 'vitest';
import type { Company } from '../lib/api';
import { recipientPreview } from './recipient';

/** Eine Organisation mit ausschließlich leeren Feldern als Ausgangspunkt. */
function company(part: Partial<Company>): Company {
  return {
    id: 'o1',
    name: 'Musterverein Ostend e. V.',
    legalForm: null,
    website: null,
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
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    contactRole: null,
    deputyName: null,
    deputyEmail: null,
    deputyPhone: null,
    deputyRole: null,
    status: 'paying',
    lastStatusChangeAt: null,
    priceTier: null,
    paymentInterval: null,
    paymentMethod: null,
    paymentDetailsStored: false,
    pilotDecisionDate: null,
    reviewDueDate: null,
    reviewDoneAt: null,
    instanceStartDate: null,
    newsletterConsentStatus: null,
    source: null,
    notes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...part,
  };
}

describe('empfaengerVorschau', () => {
  it('nimmt die Hausanschrift, wenn keine Rechnungsadresse gepflegt ist', () => {
    const v = recipientPreview(
      company({
        street: 'Hauptstraße',
        houseNumber: '3a',
        postalCode: '04103',
        city: 'Leipzig',
        country: 'Deutschland',
      }),
    );
    expect(v.name).toBe('Musterverein Ostend e. V.');
    expect(v.address).toBe('Hauptstraße 3a\n04103 Leipzig\nDeutschland');
  });

  it('lässt die Rechnungsadresse die Anschrift als GANZES stechen', () => {
    // Kein Feld der Hausanschrift darf dazwischenrutschen — sonst entstünde
    // eine Anschrift, die es nirgends gibt.
    const v = recipientPreview(
      company({
        street: 'Hauptstraße',
        houseNumber: '3a',
        postalCode: '04103',
        city: 'Leipzig',
        country: 'Deutschland',
        billingName: 'Musterverein Ostend e. V. — Buchhaltung',
        billingStreet: 'Postfach',
        billingHouseNumber: '12',
        billingPostalCode: '04001',
        billingCity: 'Leipzig',
      }),
    );
    expect(v.name).toBe('Musterverein Ostend e. V. — Buchhaltung');
    expect(v.address).toBe('Postfach 12\n04001 Leipzig');
    expect(v.address).not.toContain('Hauptstraße');
  });

  it('lässt leere Zeilen weg, statt Lücken in die Anschrift zu schreiben', () => {
    const v = recipientPreview(company({ city: 'Leipzig' }));
    expect(v.address).toBe('Leipzig');
  });

  it('nimmt die Rechnungs-E-Mail vor der Ansprechpartnerin', () => {
    expect(
      recipientPreview(
        company({
          billingEmail: 'buchhaltung@example.com',
          contactEmail: 'vorstand@example.com',
        }),
      ).email,
    ).toBe('buchhaltung@example.com');
    expect(
      recipientPreview(
        company({ contactEmail: 'vorstand@example.com' }),
      ).email,
    ).toBe('vorstand@example.com');
    expect(recipientPreview(company({})).email).toBeNull();
  });
});
