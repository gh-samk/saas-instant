// Fiktive Testdaten der Suite "vault". Jeder Wert ist ein Marker, der in der Datenbank NIE im Klartext stehen darf
// (nur example.com, erfundene Namen; die IBAN trägt eine gültige Prüfziffer, gehört aber zu keinem echten Konto).

export const ORG = {
  name: 'Zebrafink Quellenhof e. V.',
  legalForm: 'Körperschaft',
  website: 'https://quellenhof-vault.example.com',
  street: 'Haselnussgasse',
  houseNumber: '17',
  postalCode: '77777',
  city: 'Wiesenbrunn',
  country: 'DE',
  contactName: 'Ottilie Brombeerstrunk',
  contactEmail: 'ottilie.brombeerstrunk@quellenhof-vault.example.com',
  contactPhone: '+49 30 5550199',
  billingEmail: 'rechnung.quellenhof@vault-e2e.example.com',
  vatId: 'DE987654321',
  notes: 'Interne Bemerkung: Dachsbau-Sonderkonditionen vereinbart.',
  buyerType: 'business',
  paymentInterval: 'yearly',
  paymentMethod: 'bank_transfer',
};
export const IBAN = 'DE44500105175407324931';
export const IBAN_SPACED = 'DE44 5001 0517 5407 3249 31';
export const NOTE_TEXT = 'Rückruf vereinbart: Frau Brombeerstrunk wünscht ein Angebot für den Kellerfest-Katalog.';
export const INVOICE_INTRO = 'Vielen Dank, Frau Brombeerstrunk. Wir berechnen Ihnen für den Leistungszeitraum:';
export const LINE = {
  label: 'Quellenhof-Nutzung', description: 'Monatliche Nutzung Fledermausstollen', quantity: 1,
  unitPriceNetCent: 4900, taxRate: 19, unit: 'MON',
};
export const CONSENT_EMAIL = 'newsletter.hasenpfote@consent-vault.example.com';
export const CONSENT_TEXT = 'Ich möchte den Hasenpfote-Rundbrief erhalten und kann ihn jederzeit abbestellen.';

/** Alles, was in einem Dump nicht stehen darf (Beschriftung, Wert). Groß-/Kleinschreibung wird ignoriert. */
export const NEEDLES = [
  ['Organisationsname', ORG.name],
  ['Organisationsname (Kern)', 'Zebrafink'],
  ['Straße', ORG.street],
  ['Ort', ORG.city],
  ['Ansprechperson', ORG.contactName],
  ['Nachname', 'Brombeerstrunk'],
  ['Kontakt-E-Mail', ORG.contactEmail],
  ['Kontakt-E-Mail (lokaler Teil)', 'ottilie.brombeerstrunk'],
  ['Kontakt-Domain', 'quellenhof-vault.example.com'],
  ['Rechnungs-E-Mail', ORG.billingEmail],
  ['Rechnungs-Domain', 'vault-e2e.example.com'],
  ['IBAN', IBAN],
  ['IBAN (mit Leerzeichen)', IBAN_SPACED],
  ['USt-IdNr.', ORG.vatId],
  ['Telefon', ORG.contactPhone],
  ['interne Bemerkung', 'Dachsbau-Sonderkonditionen'],
  ['Notiztext', 'Kellerfest-Katalog'],
  ['Rechnungseinleitung', 'Wir berechnen Ihnen für den Leistungszeitraum'],
  ['Rechnungsposition', 'Fledermausstollen'],
  ['Consent-E-Mail', CONSENT_EMAIL],
  ['Consent-Domain', 'consent-vault.example.com'],
  ['Consent-Text', 'Hasenpfote-Rundbrief'],
];
