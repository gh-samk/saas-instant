/**
 * Angaben der Rechnungsstellerin (Briefkopf, Fußzeile) und ihre Prüfung.
 *
 * Reine Funktionen ohne Abhängigkeiten. Die Pflichtangaben je Rechtsform sind
 * in `docs/operations/invoice-legal-requirements.md` begründet; die Tabelle
 * `REQUIREMENTS` bildet sie 1:1 ab. Keine Rechtsberatung.
 */

export type LegalForm =
  | 'einzelunternehmen'
  | 'gbr'
  | 'ohg'
  | 'gmbh'
  | 'gmbh_co_kg'
  | 'eg'
  | 'ug'
  | 'ev';

export const LEGAL_FORMS: Record<LegalForm, string> = {
  einzelunternehmen: 'Einzelunternehmen / Freiberuf',
  gbr: 'GbR',
  ohg: 'OHG',
  gmbh: 'GmbH',
  gmbh_co_kg: 'GmbH & Co. KG',
  eg: 'eG (Genossenschaft)',
  ug: 'UG (haftungsbeschränkt)',
  ev: 'e.V. (Verein)',
};

export interface GeneralPartner {
  name: string;
  seat: string;
  registerCourt: string;
  registerNumber: string;
  managingDirectors: string[];
  supervisoryChair: string;
}

export interface IssuerProfile {
  legalForm: LegalForm;
  /** Einzelunternehmen: e.K. eingetragen; GbR: eGbR eingetragen. */
  registered: boolean;
  /** Firma bzw. Name wie im Register (mit Rechtsformzusatz). */
  name: string;
  ownerName: string;
  /** GbR-Gesellschafter. */
  partners: string[];
  street: string;
  postalCode: string;
  city: string;
  country: string;
  seat: string;
  registerCourt: string;
  /** Volle Nummer inkl. Präfix (HRA/HRB/GnR/VR). */
  registerNumber: string;
  /** Geschäftsführer (GmbH, UG) bzw. Vorstand (eG, e.V.). */
  managingPersons: string[];
  supervisoryChair: string;
  shareCapital: string;
  outstandingContributions: string;
  liquidation: boolean;
  generalPartner: GeneralPartner;
  vatId: string;
  taxNumber: string;
  phone: string;
  email: string;
  web: string;
  bankName: string;
  accountHolder: string;
  iban: string;
  bic: string;
  creditorId: string;
}

export function emptyIssuerProfile(
  legalForm: LegalForm = 'einzelunternehmen',
): IssuerProfile {
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
    supervisoryChair: '',
    shareCapital: '',
    outstandingContributions: '',
    liquidation: false,
    generalPartner: {
      name: '',
      seat: '',
      registerCourt: '',
      registerNumber: '',
      managingDirectors: [],
      supervisoryChair: '',
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

export const ISSUER_FIELD_LABELS: Record<string, string> = {
  legalForm: 'Rechtsform',
  registered: 'Im Register eingetragen',
  name: 'Firma / Name',
  ownerName: 'Name der Inhaberin / des Inhabers',
  partners: 'Gesellschafter',
  street: 'Straße und Hausnummer',
  postalCode: 'Postleitzahl',
  city: 'Ort',
  country: 'Land',
  seat: 'Sitz',
  registerCourt: 'Registergericht',
  registerNumber: 'Registernummer',
  managingPersons: 'Geschäftsführung / Vorstand',
  supervisoryChair: 'Vorsitz des Aufsichtsrats',
  shareCapital: 'Stammkapital',
  outstandingContributions: 'Ausstehende Einlagen',
  liquidation: 'In Liquidation',
  'generalPartner.name': 'Komplementärin: Firma',
  'generalPartner.seat': 'Komplementärin: Sitz',
  'generalPartner.registerCourt': 'Komplementärin: Registergericht',
  'generalPartner.registerNumber': 'Komplementärin: Registernummer (HRB)',
  'generalPartner.managingDirectors': 'Komplementärin: Geschäftsführung',
  'generalPartner.supervisoryChair': 'Komplementärin: Vorsitz des Aufsichtsrats',
  vatId: 'USt-IdNr.',
  taxNumber: 'Steuernummer',
  phone: 'Telefon',
  email: 'E-Mail',
  web: 'Web',
  bankName: 'Bank',
  accountHolder: 'Kontoinhaber',
  iban: 'IBAN',
  bic: 'BIC',
  creditorId: 'Gläubiger-ID',
};

type FieldPath =
  | keyof IssuerProfile
  | 'generalPartner.name'
  | 'generalPartner.seat'
  | 'generalPartner.registerCourt'
  | 'generalPartner.registerNumber'
  | 'generalPartner.managingDirectors';

const COMMON: FieldPath[] = [
  'name',
  'street',
  'postalCode',
  'city',
  'country',
  'iban',
];

const REGISTER: FieldPath[] = ['seat', 'registerCourt', 'registerNumber'];

/**
 * Pflichtfelder je Rechtsform (zusätzlich zu COMMON und "USt-IdNr. oder
 * Steuernummer"). `registered` ergänzt die Felder für e.K. und eGbR.
 */
export const REQUIREMENTS: Record<
  LegalForm,
  { always: FieldPath[]; whenRegistered: FieldPath[] }
> = {
  einzelunternehmen: { always: ['ownerName'], whenRegistered: REGISTER },
  gbr: { always: ['partners'], whenRegistered: REGISTER },
  ohg: { always: REGISTER, whenRegistered: [] },
  gmbh: { always: [...REGISTER, 'managingPersons'], whenRegistered: [] },
  ug: { always: [...REGISTER, 'managingPersons'], whenRegistered: [] },
  gmbh_co_kg: {
    always: [
      ...REGISTER,
      'generalPartner.name',
      'generalPartner.seat',
      'generalPartner.registerCourt',
      'generalPartner.registerNumber',
      'generalPartner.managingDirectors',
    ],
    whenRegistered: [],
  },
  eg: { always: [...REGISTER, 'managingPersons'], whenRegistered: [] },
  ev: { always: [...REGISTER, 'managingPersons'], whenRegistered: [] },
};

export type IssuerIssueCode =
  | 'missing'
  | 'format'
  | 'legalFormSuffix'
  | 'personName'
  | 'iban'
  | 'vatId';

export interface IssuerIssue {
  field: string;
  code: IssuerIssueCode;
  label: string;
}

const t = (v: string | undefined): string => (v ?? '').trim();
const list = (v: string[] | undefined): string[] =>
  (v ?? []).map((x) => x.trim()).filter((x) => x !== '');

function getValue(p: IssuerProfile, path: string): string | string[] {
  if (path.startsWith('generalPartner.')) {
    const key = path.slice('generalPartner.'.length) as keyof GeneralPartner;
    return p.generalPartner[key];
  }
  return p[path as keyof IssuerProfile] as string | string[];
}

// ---------------------------------------------------------------------------
// Formatprüfungen
// ---------------------------------------------------------------------------

const L = '\\p{L}';
const SUFFIX: Record<string, RegExp> = {
  gmbh: /gmbh(?![\p{L}])|gesellschaft mit beschränkter haftung/iu,
  ug: /(unternehmergesellschaft|\bUG)\s*\(\s*haftungsbeschränkt\s*\)/iu,
  gmbhOrUg:
    /gmbh(?![\p{L}])|gesellschaft mit beschränkter haftung|(unternehmergesellschaft|\bUG)\s*\(\s*haftungsbeschränkt\s*\)/iu,
  ek: new RegExp(
    `(?<![${L}])e\\.\\s?K\\.?(?![${L}])|(?<![${L}])eK(?![${L}])|eingetragene[rn]?\\s+(kauffrau|kaufmann)`,
    'iu',
  ),
  egbr: new RegExp(`(?<![${L}])eGbR(?![${L}])`, 'iu'),
  eg: new RegExp(
    `(?<![${L}])e\\.?\\s?G\\.?(?![${L}])|eingetragene genossenschaft`,
    'iu',
  ),
  ev: new RegExp(
    `(?<![${L}])e\\.\\s?V\\.?(?![${L}])|(?<![${L}])eV(?![${L}])|eingetragener verein`,
    'iu',
  ),
  kg: new RegExp(`(?<![${L}])KG(?![${L}])|kommanditgesellschaft`, 'iu'),
  ohg: new RegExp(`(?<![${L}])OHG(?![${L}])|offene handelsgesellschaft`, 'iu'),
};

function nameSuffixOk(p: IssuerProfile): boolean {
  const n = t(p.name);
  switch (p.legalForm) {
    case 'einzelunternehmen':
      return !p.registered || SUFFIX.ek!.test(n);
    case 'gbr':
      return !p.registered || SUFFIX.egbr!.test(n);
    case 'ohg':
      return SUFFIX.ohg!.test(n);
    case 'gmbh':
      return SUFFIX.gmbh!.test(n);
    case 'ug':
      return SUFFIX.ug!.test(n);
    case 'gmbh_co_kg':
      return SUFFIX.kg!.test(n);
    case 'eg':
      return SUFFIX.eg!.test(n);
    case 'ev':
      return SUFFIX.ev!.test(n);
  }
}

/** "Vorname Nachname": mindestens zwei Wörter, Vorname kein einzelner Initial. */
export function isFullPersonName(value: string): boolean {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  return !/^\p{L}\.?$/u.test(words[0]!);
}

export function isValidIban(value: string): boolean {
  const iban = value.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

export function isValidVatId(value: string): boolean {
  return /^[A-Z]{2}[A-Z0-9]{2,12}$/.test(value.replace(/\s+/g, ''));
}

// ---------------------------------------------------------------------------
// Validierung
// ---------------------------------------------------------------------------

export function validateIssuerProfile(profile: IssuerProfile): IssuerIssue[] {
  const issues: IssuerIssue[] = [];
  const add = (field: string, code: IssuerIssueCode): void => {
    issues.push({ field, code, label: ISSUER_FIELD_LABELS[field] ?? field });
  };
  const req = REQUIREMENTS[profile.legalForm];
  const required: FieldPath[] = [
    ...COMMON,
    ...req.always,
    ...(profile.registered ? req.whenRegistered : []),
  ];
  const seen = new Set<string>();
  for (const field of required) {
    if (seen.has(field)) continue;
    seen.add(field);
    const v = getValue(profile, field);
    const empty = Array.isArray(v) ? list(v).length === 0 : t(v) === '';
    if (empty) add(field, 'missing');
  }
  const missing = (f: string): boolean => issues.some((i) => i.field === f);

  if (t(profile.vatId) === '' && t(profile.taxNumber) === '') {
    issues.push({
      field: 'vatId',
      code: 'missing',
      label: 'USt-IdNr. oder Steuernummer',
    });
  }
  if (
    (profile.legalForm === 'gmbh' || profile.legalForm === 'ug') &&
    t(profile.shareCapital) !== '' &&
    t(profile.outstandingContributions) === ''
  ) {
    add('outstandingContributions', 'missing');
  }

  if (!missing('name') && !nameSuffixOk(profile)) add('name', 'legalFormSuffix');
  if (
    profile.legalForm === 'gmbh_co_kg' &&
    !missing('generalPartner.name') &&
    !SUFFIX.gmbhOrUg!.test(t(profile.generalPartner.name))
  ) {
    add('generalPartner.name', 'legalFormSuffix');
  }

  const checkNames = (field: string, names: string[]): void => {
    if (names.some((n) => !isFullPersonName(n))) add(field, 'personName');
  };
  if (profile.legalForm === 'einzelunternehmen' && t(profile.ownerName) !== '') {
    checkNames('ownerName', [profile.ownerName]);
  }
  if (profile.legalForm === 'gbr') checkNames('partners', list(profile.partners));
  if (['gmbh', 'ug', 'eg', 'ev'].includes(profile.legalForm)) {
    checkNames('managingPersons', list(profile.managingPersons));
  }
  if (profile.legalForm === 'gmbh_co_kg') {
    checkNames(
      'generalPartner.managingDirectors',
      list(profile.generalPartner.managingDirectors),
    );
  }

  const registerNumbers: Array<[string, string]> = [
    ['registerNumber', profile.registerNumber],
  ];
  if (profile.legalForm === 'gmbh_co_kg') {
    registerNumbers.push([
      'generalPartner.registerNumber',
      profile.generalPartner.registerNumber,
    ]);
  }
  for (const [field, value] of registerNumbers) {
    if (t(value) !== '' && !/\d/.test(value)) add(field, 'format');
  }

  if (t(profile.iban) !== '' && !isValidIban(profile.iban)) add('iban', 'iban');
  if (t(profile.vatId) !== '' && !isValidVatId(profile.vatId)) {
    add('vatId', 'vatId');
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Briefkopf und Fußzeile
// ---------------------------------------------------------------------------

export interface IssuerBlocks {
  companyLines: string[];
  contactLines: string[];
  bankLines: string[];
  legalLines: string[];
}

export function formatIban(iban: string): string {
  return iban
    .replace(/\s+/g, '')
    .toUpperCase()
    .replace(/(.{4})/g, '$1 ')
    .trim();
}

const normalize = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

function money(value: string): string {
  return `${t(value).replace(/\s*(€|EUR)\s*$/i, '')} €`;
}

function court(prefix: string, name: string, number: string): string {
  const n = t(name);
  const place = new RegExp(`^${prefix}\\b`, 'i').test(n) ? n : `${prefix} ${n}`;
  return `${place}, ${t(number)}`;
}

export function buildIssuerBlocks(profile: IssuerProfile): IssuerBlocks {
  const p = profile;
  const companyLines = [t(p.name), t(p.street), `${t(p.postalCode)} ${t(p.city)}`.trim()];
  const country = t(p.country);
  if (country !== '' && !/^(deutschland|germany|de)$/i.test(country)) {
    companyLines.push(country);
  }

  const contactLines: string[] = [];
  if (t(p.phone)) contactLines.push(`Tel. ${t(p.phone)}`);
  if (t(p.email)) contactLines.push(t(p.email));
  if (t(p.web)) contactLines.push(t(p.web));

  const bankLines: string[] = [];
  if (t(p.bankName)) bankLines.push(t(p.bankName));
  if (t(p.accountHolder) && normalize(p.accountHolder) !== normalize(p.name)) {
    bankLines.push(`Kontoinhaber: ${t(p.accountHolder)}`);
  }
  if (t(p.iban)) bankLines.push(`IBAN ${formatIban(p.iban)}`);
  if (t(p.bic)) bankLines.push(`BIC ${t(p.bic).replace(/\s+/g, '')}`);

  const legal: string[] = [];
  const seat =
    t(p.seat) !== '' && normalize(p.seat) !== normalize(p.city)
      ? [`Sitz ${t(p.seat)}`]
      : [];
  const amtsgericht = (prefix: string): string =>
    court(prefix, p.registerCourt, p.registerNumber);
  const persons = (label: string, names: string[]): string[] =>
    list(names).length ? [`${label} ${list(names).join(', ')}`] : [];
  const chair = (name: string): string[] =>
    t(name) ? [`Aufsichtsratsvorsitz ${t(name)}`] : [];

  switch (p.legalForm) {
    case 'einzelunternehmen':
      if (p.registered) legal.push(...seat, amtsgericht('Amtsgericht'));
      else legal.push(`Inhaber: ${t(p.ownerName)}`);
      break;
    case 'gbr':
      legal.push(...seat);
      legal.push(...persons('Gesellschafter:', p.partners));
      if (p.registered) legal.push(court('GbR-Register', p.registerCourt, p.registerNumber));
      break;
    case 'ohg':
      legal.push(...seat, amtsgericht('Amtsgericht'));
      break;
    case 'gmbh':
    case 'ug':
      legal.push(...seat, amtsgericht('Amtsgericht'));
      legal.push(...persons('Geschäftsführung', p.managingPersons));
      legal.push(...chair(p.supervisoryChair));
      if (t(p.shareCapital)) {
        legal.push(
          `Stammkapital ${money(p.shareCapital)}` +
            (t(p.outstandingContributions)
              ? `, ausstehende Einlagen ${money(p.outstandingContributions)}`
              : ''),
        );
      }
      if (p.liquidation) legal.push('In Liquidation');
      break;
    case 'gmbh_co_kg': {
      const gp = p.generalPartner;
      legal.push(...seat, amtsgericht('Amtsgericht'));
      legal.push('Persönlich haftende Gesellschafterin:');
      legal.push(`${t(gp.name)}, Sitz ${t(gp.seat)}`);
      legal.push(court('Amtsgericht', gp.registerCourt, gp.registerNumber));
      legal.push(...persons('Geschäftsführung', gp.managingDirectors));
      legal.push(...chair(gp.supervisoryChair));
      break;
    }
    case 'eg':
      legal.push(...seat, court('Genossenschaftsregister', p.registerCourt, p.registerNumber));
      legal.push(...persons('Vorstand', p.managingPersons));
      legal.push(...chair(p.supervisoryChair));
      break;
    case 'ev':
      legal.push(...seat, amtsgericht('Amtsgericht'));
      legal.push(...persons('Vorstand', p.managingPersons));
      break;
  }
  if (t(p.vatId)) legal.push(`USt-IdNr. ${t(p.vatId).replace(/\s+/g, '')}`);
  if (t(p.taxNumber)) legal.push(`St.-Nr. ${t(p.taxNumber)}`);

  return { companyLines, contactLines, bankLines, legalLines: legal };
}

// ---------------------------------------------------------------------------
// Akzentfarbe
// ---------------------------------------------------------------------------

const DARK_BACKGROUND = '#0f1318';

function toRgb(hex: string): [number, number, number] {
  const v = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(hexA: string, hexB: string): number {
  const a = luminance(hexA);
  const b = luminance(hexB);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export interface AccentColorCheck {
  valid: boolean;
  error?: 'format' | 'contrast';
  contrastOnWhite?: number;
  /** Für den Dunkelmodus aufgehellter Wert, Kontrast >= 4,5 zu #0f1318. */
  accentOnDark?: string;
}

function lighten(hex: string, amount: number): string {
  return (
    '#' +
    toRgb(hex)
      .map((c) =>
        Math.round(c + (255 - c) * amount)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

export function validateAccentColor(hex: string): AccentColorCheck {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return { valid: false, error: 'format' };
  const color = hex.toLowerCase();
  let onDark = color;
  for (let i = 1; contrastRatio(onDark, DARK_BACKGROUND) < 4.5 && i <= 20; i++) {
    onDark = lighten(color, i * 0.05);
  }
  const contrastOnWhite = contrastRatio(color, '#ffffff');
  return {
    valid: contrastOnWhite >= 4.5,
    ...(contrastOnWhite >= 4.5 ? {} : { error: 'contrast' as const }),
    contrastOnWhite,
    accentOnDark: onDark,
  };
}
