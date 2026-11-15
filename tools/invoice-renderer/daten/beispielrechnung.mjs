// Neutrale Beispielrechnung fuer Tests und `node src/erzeuge.mjs`.
// Alle Angaben sind erfunden (Platzhalterfirma, Beispiel-IBAN).

export const beispielrechnung = {
  nummer: '2026-001',
  rechnungsdatum: '2026-08-31',
  faelligAm: '2026-09-14',
  lieferdatum: '2026-08-31',
  leistungszeitraum: { von: '2026-09-01', bis: '2027-08-31' },
  bestellzeichen: '2026-001',
  waehrung: 'EUR',
  zahlungsbedingung: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
  hinweis: 'Vielen Dank für Ihren Auftrag.',
  aussteller: {
    name: 'Example Company GmbH & Co KG',
    anschrift: { strasse: 'Example Street 1', plz: '12345', ort: 'Example City', land: 'DE' },
    kontakt: { name: 'Rechnungsstelle', telefon: '+49 000 0000000', email: 'billing@example.com' },
    ustIdNr: 'DE123456789',
    registergericht: 'Amtsgericht Example City',
    registerKennung: 'HRA 00000',
    // Optional: ohne `komplementaerin` druckt das Layout keinen entsprechenden Block.
    komplementaerin: {
      name: 'Example Management GmbH',
      registergericht: 'Amtsgericht Example City',
      registerKennung: 'HRB 00000',
      geschaeftsfuehrer: ['Erika Mustermann'],
    },
    bank: { institut: 'Example Bank', iban: 'DE02120300000000202051', bic: 'BYLADEM1001' },
    // Fertige Druckzeilen, wie sie das Backend je Rechtsform bildet. Der Renderer
    // druckt nur diese Zeilen und kennt keine Rechtsformlogik.
    blocks: {
      companyLines: ['Example Company GmbH & Co KG', 'Example Street 1', '12345 Example City'],
      contactLines: ['Tel. +49 000 0000000', 'billing@example.com', 'www.example.com'],
      bankLines: ['Example Bank', 'Kontoinhaber: Example Management GmbH', 'IBAN DE02 1203 0000 0000 2020 51', 'BIC BYLADEM1001'],
      legalLines: [
        'Amtsgericht Example City, HRA 00000',
        'Persönlich haftende Gesellschafterin:',
        'Example Management GmbH, HRB 00000',
        'Geschäftsführung Erika Mustermann',
        'USt-IdNr. DE123456789',
      ],
    },
    logoDataUri: null,
    accentColor: null,
    rechtlicherZusatz:
      'Example Company GmbH & Co KG, Sitz Example City, Amtsgericht Example City HRA 00000. ' +
      'Persönlich haftende Gesellschafterin: Example Management GmbH, Sitz Example City, ' +
      'Amtsgericht Example City HRB 00000. Geschäftsführer: Erika Mustermann.',
  },
  empfaenger: {
    name: 'Beispielverein e. V.',
    ansprechpartner: 'Max Muster',
    email: 'kasse@example.org',
    anschrift: { strasse: 'Musterweg 2', plz: '54321', ort: 'Musterstadt', land: 'DE' },
  },
  posten: [
    {
      bezeichnung: 'Nutzung der Software, 12 Monate',
      beschreibung: 'Leistungszeitraum 01.09.2026 bis 31.08.2027',
      menge: 1,
      einheit: 'C62',
      einzelpreisCent: 87500,
      steuersatz: 19,
    },
  ],
};
