// Fiktive Firmendaten je Rechtsform für die Suite "invoice" (PUT /api/settings/issuer).
//
// Alles frei erfunden (example.com, Musterstadt, Beispielhausen). Die erwarteten Pflichtzeilen (`legalLines`) sind
// HIER von Hand aus docs/operations/invoice-legal-requirements.md abgeleitet und nicht aus dem Produktcode berechnet:
// Stimmt die Anzeige im PDF nicht mit dieser Erwartung überein, ist entweder das Produkt oder die Spezifikation falsch.
// Die Platzhalterwerte des Produkts (Example Company, DE123456789, DE02120300000000202051) werden bewusst gemieden.
import { deflateSync } from 'node:zlib';

/** Leeres, vollständig besetztes Profil (alle Felder, die das DTO verlangt). */
export function blankProfile(legalForm) {
  return {
    legalForm,
    registered: false,
    name: '',
    ownerName: '',
    partners: [],
    street: '',
    postalCode: '',
    city: '',
    country: 'Deutschland',
    seat: '',
    registerCourt: '',
    registerNumber: '',
    managingPersons: [],
    generalPartner: {
      name: '', seat: '', registerCourt: '', registerNumber: '', managingDirectors: [],
    },
    vatId: '',
    taxNumber: '',
    phone: '',
    email: '',
    web: '',
    bankName: '',
    accountHolder: '',
    iban: '',
    bic: '',
    creditorId: '',
  };
}

export const spacedIban = (iban) => iban.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();

/** Anschrift des Ausstellers (für alle Formen gleich; der Empfänger sitzt bewusst woanders). */
export const ISSUER_ADDRESS = { street: 'Musterstraße 1', postalCode: '99999', city: 'Musterstadt' };
export const ISSUER_CONTACT = { phone: '+49 30 1234567', email: 'rechnung@example.com', web: 'www.example.com' };
const VAT = 'DE136695976';
const BANK = { bankName: 'Beispielbank', bic: 'COBADEFFXXX' };
const IBAN = 'DE89370400440532013000';
const SEAT = 'Beispielhausen';
const COURT = 'Amtsgericht Beispielhausen';

function complete(legalForm, over) {
  const gp = { ...blankProfile(legalForm).generalPartner, ...(over.generalPartner ?? {}) };
  return {
    ...blankProfile(legalForm),
    ...ISSUER_ADDRESS,
    ...ISSUER_CONTACT,
    ...BANK,
    iban: IBAN,
    vatId: VAT,
    ...over,
    generalPartner: gp,
  };
}

/**
 * Eine Form = ein Fall der Matrix.
 *  - profile:     vollständig
 *  - broken:      Änderungen am vollständigen Profil, die es unvollständig machen
 *  - expected:    genau die Felder (und Codes), die das Festschreiben dann nennen muss
 *  - legalLines:  was in Fußzeile und BT-33 des fertigen Dokuments stehen muss
 *  - xr:          zusätzlich XRechnung erzeugen und mit KoSIT prüfen
 */
export const FORMS = [
  {
    key: 'einzelunternehmen',
    label: 'Einzelunternehmen (nicht eingetragen), nur Steuernummer',
    profile: complete('einzelunternehmen', {
      name: 'Erika Beispiel Webdesign',
      ownerName: 'Erika Beispiel',
      vatId: '',
      taxNumber: '12/345/67890',
    }),
    broken: { ownerName: '', street: '', iban: '', taxNumber: '' },
    expected: { ownerName: 'missing', street: 'missing', iban: 'missing', vatId: 'missing' },
    legalLines: ['Inhaber: Erika Beispiel', 'St.-Nr. 12/345/67890'],
  },
  {
    key: 'einzelunternehmen-ek',
    label: 'Einzelunternehmen, eingetragen (e.K.)',
    profile: complete('einzelunternehmen', {
      registered: true,
      name: 'Beispiel Kaffeerösterei e.K.',
      ownerName: 'Max Beispiel',
      seat: SEAT,
      registerCourt: COURT,
      registerNumber: 'HRA 12345',
    }),
    broken: { name: 'Beispiel Kaffeerösterei', ownerName: '', seat: '', registerCourt: '', registerNumber: '' },
    expected: {
      name: 'legalFormSuffix', ownerName: 'missing', seat: 'missing', registerCourt: 'missing', registerNumber: 'missing',
    },
    legalLines: [`Sitz ${SEAT}`, `${COURT}, HRA 12345`, `USt-IdNr. ${VAT}`],
  },
  {
    key: 'gbr',
    label: 'GbR (nicht eingetragen)',
    profile: complete('gbr', {
      name: 'Beispiel Gartenbau GbR',
      partners: ['Anna Muster', 'Ben Muster'],
    }),
    broken: { partners: [], postalCode: '' },
    expected: { partners: 'missing', postalCode: 'missing' },
    legalLines: ['Gesellschafter: Anna Muster, Ben Muster', `USt-IdNr. ${VAT}`],
  },
  {
    key: 'egbr',
    label: 'eGbR (eingetragene GbR)',
    profile: complete('gbr', {
      registered: true,
      name: 'Beispiel Imkerei eGbR',
      partners: ['Clara Muster'],
      seat: SEAT,
      registerCourt: COURT,
      registerNumber: 'GsR 4711',
    }),
    broken: { name: 'Beispiel Imkerei GbR', partners: [], seat: '', registerCourt: '', registerNumber: '' },
    expected: {
      name: 'legalFormSuffix', partners: 'missing', seat: 'missing', registerCourt: 'missing', registerNumber: 'missing',
    },
    legalLines: [`Sitz ${SEAT}`, 'Gesellschafter: Clara Muster', `GbR-Register ${COURT}, GsR 4711`, `USt-IdNr. ${VAT}`],
  },
  {
    key: 'ohg',
    label: 'OHG',
    profile: complete('ohg', {
      name: 'Beispiel Metallbau OHG',
      seat: SEAT,
      registerCourt: COURT,
      registerNumber: 'HRA 20202',
    }),
    broken: { seat: '', registerNumber: 'ohne Nummer', city: '' },
    expected: { seat: 'missing', registerNumber: 'format', city: 'missing' },
    legalLines: [`Sitz ${SEAT}`, `${COURT}, HRA 20202`, `USt-IdNr. ${VAT}`],
  },
  {
    key: 'gmbh',
    label: 'GmbH mit zwei Geschäftsführern',
    profile: complete('gmbh', {
      name: 'Beispiel Software GmbH',
      seat: SEAT,
      registerCourt: COURT,
      registerNumber: 'HRB 30303',
      managingPersons: ['Erika Mustermann', 'Max Mustermann'],
    }),
    broken: { managingPersons: ['E. Mustermann'], registerNumber: '' },
    expected: { managingPersons: 'personName', registerNumber: 'missing' },
    legalLines: [
      `Sitz ${SEAT}`,
      `${COURT}, HRB 30303`,
      'Geschäftsführung Erika Mustermann, Max Mustermann',
      `USt-IdNr. ${VAT}`,
    ],
    xr: true,
  },
  {
    key: 'ug',
    label: 'UG (haftungsbeschränkt)',
    profile: complete('ug', {
      name: 'Beispiel Start UG (haftungsbeschränkt)',
      seat: SEAT,
      registerCourt: COURT,
      registerNumber: 'HRB 40404',
      managingPersons: ['Lena Gründer'],
    }),
    broken: { name: 'Beispiel Start UG', seat: '', managingPersons: [] },
    expected: { name: 'legalFormSuffix', seat: 'missing', managingPersons: 'missing' },
    legalLines: [`Sitz ${SEAT}`, `${COURT}, HRB 40404`, 'Geschäftsführung Lena Gründer', `USt-IdNr. ${VAT}`],
  },
  {
    key: 'gmbh-co-kg',
    label: 'GmbH & Co. KG mit Komplementär-GmbH',
    profile: complete('gmbh_co_kg', {
      name: 'Beispiel Energie GmbH & Co. KG',
      seat: SEAT,
      registerCourt: COURT,
      registerNumber: 'HRA 50505',
      generalPartner: {
        name: 'Beispiel Energie Verwaltungs GmbH',
        seat: SEAT,
        registerCourt: COURT,
        registerNumber: 'HRB 60606',
        managingDirectors: ['Erika Mustermann'],
      },
    }),
    broken: {
      registerNumber: '',
      generalPartner: { name: '', seat: '', registerCourt: '', registerNumber: '', managingDirectors: [] },
    },
    expected: {
      registerNumber: 'missing',
      'generalPartner.name': 'missing',
      'generalPartner.seat': 'missing',
      'generalPartner.registerCourt': 'missing',
      'generalPartner.registerNumber': 'missing',
      'generalPartner.managingDirectors': 'missing',
    },
    legalLines: [
      `Sitz ${SEAT}`,
      `${COURT}, HRA 50505`,
      'Persönlich haftende Gesellschafterin:',
      `Beispiel Energie Verwaltungs GmbH, Sitz ${SEAT}`,
      `${COURT}, HRB 60606`,
      'Geschäftsführung Erika Mustermann',
      `USt-IdNr. ${VAT}`,
    ],
    xr: true,
  },
  {
    key: 'eg',
    label: 'eG (Genossenschaft) mit Vorstand',
    profile: complete('eg', {
      name: 'Beispiel Dorfladen eG',
      seat: SEAT,
      registerCourt: COURT,
      registerNumber: 'GnR 70707',
      managingPersons: ['Paul Vorstand', 'Petra Vorstand'],
    }),
    broken: { managingPersons: [], registerNumber: '', iban: 'DE00 1234' },
    expected: { managingPersons: 'missing', registerNumber: 'missing', iban: 'iban' },
    legalLines: [
      `Sitz ${SEAT}`,
      `Genossenschaftsregister ${COURT}, GnR 70707`,
      'Vorstand Paul Vorstand, Petra Vorstand',
      `USt-IdNr. ${VAT}`,
    ],
    xr: true,
  },
  {
    key: 'ev',
    label: 'e.V. (Verein), nur Steuernummer',
    profile: complete('ev', {
      name: 'Beispiel Sportverein e.V.',
      seat: SEAT,
      registerCourt: COURT,
      registerNumber: 'VR 8080',
      managingPersons: ['Sven Vorstand', 'Silke Vorstand'],
      vatId: '',
      taxNumber: '98/765/43210',
    }),
    broken: { name: 'Beispiel Sportverein', registerCourt: '', managingPersons: ['Sven'], taxNumber: '' },
    expected: { name: 'legalFormSuffix', registerCourt: 'missing', managingPersons: 'personName', vatId: 'missing' },
    legalLines: [`Sitz ${SEAT}`, `${COURT}, VR 8080`, 'Vorstand Sven Vorstand, Silke Vorstand', 'St.-Nr. 98/765/43210'],
  },
];

/** Das gebrochene Profil: vollständiges Profil mit den Änderungen aus `broken` (generalPartner wird tief gemischt). */
export function brokenProfile(form) {
  const { generalPartner, ...rest } = form.broken;
  return {
    ...form.profile,
    ...rest,
    generalPartner: { ...form.profile.generalPartner, ...(generalPartner ?? {}) },
  };
}

// ------------------------------------------------------------------ Logo (PNG ohne Fremdbibliothek)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** Ein gültiges RGB-PNG (Farbverlauf mit Streifen, bewusst NICHT in der Akzentfarbe). */
export function makeLogoPng(width = 240, height = 72) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // Bittiefe
  ihdr[9] = 2; // RGB
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3); // Filter 0
    for (let x = 0; x < width; x++) {
      const stripe = Math.floor(x / 20) % 2 === 0;
      row[1 + x * 3] = stripe ? 230 : 200;
      row[2 + x * 3] = Math.round(120 + (y / height) * 80);
      row[3 + x * 3] = stripe ? 40 : 90;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Ein JPEG-Anfang (für den Test "Typ stimmt nicht mit dem Inhalt überein"). */
export const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0')]);
