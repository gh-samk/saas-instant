/**
 * DIE ZENTRALE FELDLISTE der Feldverschlüsselung.
 *
 * Wer hier ein Feld aufnimmt, verschlüsselt es für ALLE Schreibwege der
 * Prisma-Erweiterung (`prisma/field-encryption.ts`) und entschlüsselt es auf
 * allen Lesewegen. Filter (`where`) und Sortierung (`orderBy`) auf diesen
 * Feldern sind nicht möglich und werfen; exakte Treffer laufen über die
 * Blind-Index-Spalten (`BLIND_INDEXES`).
 *
 * NICHT verschlüsselt (bewusst): Mitarbeiterkonten (`User`), weil die Anmeldung
 * vor dem Entsperren funktionieren muss; IDs, Status, Beträge, Daten und
 * Rechnungsnummern, die für Abfragen und den GoBD-Nummernkreis nötig sind.
 */

export type FieldKind = 'text' | 'bytes' | 'json';

const text = (...names: string[]): Record<string, FieldKind> =>
  Object.fromEntries(names.map((n) => [n, 'text' as const]));

export const ENCRYPTED_FIELDS: Record<string, Record<string, FieldKind>> = {
  Company: text(
    'name',
    'legalForm',
    'website',
    'street',
    'houseNumber',
    'postalCode',
    'city',
    'billingName',
    'billingStreet',
    'billingHouseNumber',
    'billingPostalCode',
    'billingCity',
    'billingEmail',
    'contactName',
    'contactEmail',
    'contactPhone',
    'contactRole',
    'deputyName',
    'deputyEmail',
    'deputyPhone',
    'deputyRole',
    'sepaMandateReference',
    'iban',
    'bic',
    'accountHolder',
    'sepaMandateText',
    'sepaMandateIp',
    'notes',
    'vatId',
    'buyerReference',
    'electronicAddress',
  ),
  Note: text('text'),
  InvoiceLine: text('description'),
  Invoice: {
    ...text(
      'recipientName',
      'recipientAddress',
      'recipientEmail',
      'recipientVatId',
      'recipientBuyerReference',
      'recipientElectronicAddress',
      'issuerCompanyName',
      'issuerAddress',
      'issuerSeat',
      'issuerVatId',
      'issuerRegisterCourt',
      'issuerCommercialRegisterA',
      'issuerGeneralPartner',
      'issuerGeneralPartnerSeat',
      'issuerGeneralPartnerRegisterCourt',
      'issuerGeneralPartnerCommercialRegisterB',
      'issuerManagingDirector',
      'directDebitMandateReference',
      'issuerBankDetails',
      'issuerContactName',
      'issuerContactPhone',
      'issuerContactEmail',
      'issuerIban',
      'issuerBic',
      'issuerBankName',
      'introduction',
      'paymentNote',
      'internalNote',
      'cancellationReason',
    ),
    pdfContent: 'bytes',
    xmlContent: 'bytes',
    xrechnungContent: 'bytes',
    issuerLayout: 'json',
  },
  MailDelivery: text(
    'recipientAddress',
    'subject',
    'contentSnapshot',
    'contentSnapshotHtml',
  ),
  Consent: text(
    'email',
    'ipAtSubscription',
    'ipAtConfirmation',
    'formText',
    'blockReason',
  ),
  AuditLog: {
    beforeValue: 'json',
    afterValue: 'json',
    ...text('ip', 'userAgent'),
  },
};

export interface BlindIndexSpec {
  /** Das verschlüsselte Quellfeld. */
  source: string;
  /** Die Blind-Index-Spalte. */
  index: string;
  /** Bezeichnung im HMAC, damit Indizes verschiedener Felder nicht vergleichbar sind. */
  label: string;
}

export const BLIND_INDEXES: Record<string, BlindIndexSpec[]> = {
  Company: [
    {
      source: 'contactEmail',
      index: 'contactEmailIdx',
      label: 'Company.contactEmail',
    },
  ],
  Consent: [{ source: 'email', index: 'emailIdx', label: 'Consent.email' }],
  MailDelivery: [
    {
      source: 'recipientAddress',
      index: 'recipientIdx',
      label: 'MailDelivery.recipient',
    },
  ],
};

/** Blind-Index-Spalten sind unverschlüsselt und dürfen gefiltert werden. */
export function blindLabel(model: string, source: string): string | undefined {
  return BLIND_INDEXES[model]?.find((b) => b.source === source)?.label;
}
