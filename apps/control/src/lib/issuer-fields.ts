import {
  REQUIREMENTS,
  isValidIban,
  isValidVatId,
  type IssuerProfile,
  type LegalForm,
} from '@saas-instant/shared';

/**
 * Welche Felder der Firmendaten-Seite für welche Rechtsform erscheinen.
 *
 * Die Pflichtfelder kommen aus `REQUIREMENTS` (shared) — dieselbe Tabelle, die
 * der Server beim Festschreiben prüft. Hier kommt nur dazu, WIE sie gruppiert
 * und welche freiwilligen Felder daneben gezeigt werden.
 */

export const LEGAL_FORM_ORDER: LegalForm[] = [
  'einzelunternehmen',
  'gbr',
  'ohg',
  'gmbh',
  'ug',
  'gmbh_co_kg',
  'eg',
  'ev',
];

export type FieldKind = 'text' | 'list' | 'switch';

export interface FieldSpec {
  /** Pfad im Profil, z. B. `name` oder `generalPartner.seat`. */
  path: string;
  kind: FieldKind;
  required: boolean;
}

export interface FieldSection {
  id: 'identity' | 'address' | 'legal' | 'generalPartner' | 'bank' | 'contact' | 'tax';
  fields: FieldSpec[];
  /**
   * Abschnitt ohne jede Pflichtangabe: wird eingeklappt gezeigt. Die Steuer
   * zählt NICHT dazu — „USt-IdNr. oder Steuernummer" ist Pflicht (eine von
   * beiden), auch wenn kein einzelnes Feld es ist.
   */
  optional: boolean;
}

/** Pflichtfelder für alle Rechtsformen (spiegelt `COMMON` in shared; ein Test hält beides gleich). */
const COMMON = ['name', 'street', 'postalCode', 'city', 'country', 'iban'];
const REGISTER = ['seat', 'registerCourt', 'registerNumber'];

/** Pflichtfelder des Profils ohne die Regel „USt-IdNr. oder Steuernummer". */
export function requiredPaths(profile: IssuerProfile): string[] {
  const req = REQUIREMENTS[profile.legalForm];
  return [
    ...new Set<string>([
      ...COMMON,
      ...req.always,
      ...(profile.registered ? req.whenRegistered : []),
    ]),
  ];
}

export function planFields(profile: IssuerProfile): FieldSection[] {
  const required = new Set(requiredPaths(profile));
  const form = profile.legalForm;
  const is = (...forms: LegalForm[]): boolean => forms.includes(form);
  const field = (path: string, kind: FieldKind = 'text', needed?: boolean): FieldSpec => ({
    path,
    kind,
    required: needed ?? required.has(path),
  });

  const sections: Array<Omit<FieldSection, 'optional'>> = [];

  const identity: FieldSpec[] = [];
  if (is('einzelunternehmen', 'gbr')) identity.push(field('registered', 'switch', false));
  identity.push(field('name'));
  if (is('einzelunternehmen')) identity.push(field('ownerName'));
  if (is('gbr')) identity.push(field('partners', 'list'));
  sections.push({ id: 'identity', fields: identity });

  sections.push({
    id: 'address',
    fields: ['street', 'postalCode', 'city', 'country'].map((p) => field(p)),
  });

  const legal: FieldSpec[] = [];
  if (REGISTER.some((p) => required.has(p))) legal.push(...REGISTER.map((p) => field(p)));
  if (is('gmbh', 'ug', 'eg', 'ev')) legal.push(field('managingPersons', 'list'));
  if (legal.length > 0) sections.push({ id: 'legal', fields: legal });

  if (is('gmbh_co_kg')) {
    sections.push({
      id: 'generalPartner',
      fields: [
        field('generalPartner.name'),
        field('generalPartner.seat'),
        field('generalPartner.registerCourt'),
        field('generalPartner.registerNumber'),
        field('generalPartner.managingDirectors', 'list'),
      ],
    });
  }

  sections.push({
    id: 'bank',
    fields: [
      field('bankName', 'text', false),
      field('accountHolder', 'text', false),
      field('iban'),
      field('bic', 'text', false),
    ],
  });
  sections.push({
    id: 'contact',
    fields: ['phone', 'email', 'web'].map((p) => field(p, 'text', false)),
  });
  sections.push({
    id: 'tax',
    fields: [field('vatId', 'text', false), field('taxNumber', 'text', false)],
  });
  return sections.map((section) => ({
    ...section,
    optional: section.id !== 'tax' && !section.fields.some((f) => f.required),
  }));
}

export function getPathValue(profile: IssuerProfile, path: string): string | string[] | boolean {
  if (path.startsWith('generalPartner.')) {
    const key = path.slice('generalPartner.'.length) as keyof IssuerProfile['generalPartner'];
    return profile.generalPartner[key];
  }
  return profile[path as keyof IssuerProfile] as string | string[] | boolean;
}

export function setPathValue(
  profile: IssuerProfile,
  path: string,
  value: string | string[] | boolean,
): IssuerProfile {
  if (path.startsWith('generalPartner.')) {
    const key = path.slice('generalPartner.'.length);
    return { ...profile, generalPartner: { ...profile.generalPartner, [key]: value } };
  }
  return { ...profile, [path]: value };
}

/** Eindeutige Element-ID eines Feldes; Sprungziel der Vollständigkeitsliste. */
export function fieldId(path: string): string {
  return `firma-${path.replace('.', '-')}`;
}

/** Zusammengehörige Kurzfelder, die nebeneinander stehen (mobil untereinander). */
const ROW_GROUPS: string[][] = [
  ['postalCode', 'city', 'country'],
  ['seat', 'registerCourt', 'registerNumber'],
  ['generalPartner.seat', 'generalPartner.registerCourt', 'generalPartner.registerNumber'],
  ['bankName', 'accountHolder'],
  ['iban', 'bic'],
  ['phone', 'email'],
  ['vatId', 'taxNumber'],
];

/** Teilt die Felder eines Abschnitts in Zeilen; Felder ohne Gruppe stehen allein. */
export function layoutRows(fields: FieldSpec[]): FieldSpec[][] {
  const rows: FieldSpec[][] = [];
  const used = new Set<string>();
  for (const field of fields) {
    if (used.has(field.path)) continue;
    const group = ROW_GROUPS.find((g) => g.includes(field.path));
    const members = group ? fields.filter((f) => group.includes(f.path)) : [field];
    for (const m of members) used.add(m.path);
    rows.push(members);
  }
  return rows;
}

function hasValue(profile: IssuerProfile, path: string): boolean {
  const value = getPathValue(profile, path);
  if (Array.isArray(value)) return value.some((v) => v.trim() !== '');
  return typeof value === 'string' && value.trim() !== '';
}

/** Statuszeile eines Abschnitts: wie viele seiner Eingabefelder ausgefüllt sind. */
export function sectionProgress(
  profile: IssuerProfile,
  section: FieldSection,
): { filled: number; total: number } {
  const inputs = section.fields.filter((f) => f.kind !== 'switch');
  return {
    filled: inputs.filter((f) => hasValue(profile, f.path)).length,
    total: inputs.length,
  };
}

/** Der Abschnitt, in dem ein Feld steht (für das Aufklappen beim Sprung). */
export function sectionOf(sections: FieldSection[], path: string): FieldSection | undefined {
  return sections.find((s) => s.fields.some((f) => f.path === path));
}

/** Gesamtzahl der Pflichtangaben für die Fortschrittsanzeige (inkl. „USt-IdNr. oder Steuernummer"). */
export function requiredTotal(profile: IssuerProfile): number {
  return requiredPaths(profile).length + 1;
}

// ---------------------------------------------------------------------------
// Prüfungen beim Verlassen des Feldes
// ---------------------------------------------------------------------------

/**
 * Erwartete Präfixe der Registernummer je Rechtsform. Entspricht den Hinweisen
 * im Formular; shared prüft hier nur „enthält eine Ziffer".
 */
const REGISTER_PREFIXES: Record<LegalForm, string[]> = {
  einzelunternehmen: ['HRA'],
  gbr: ['GsR'],
  ohg: ['HRA'],
  gmbh: ['HRB'],
  ug: ['HRB'],
  gmbh_co_kg: ['HRA'],
  eg: ['GnR'],
  ev: ['VR'],
};

export function expectedRegisterPrefixes(form: LegalForm, path: string): string[] {
  return path === 'generalPartner.registerNumber' ? ['HRB'] : REGISTER_PREFIXES[form];
}

/** Stimmt das Präfix der Registernummer? Leere Werte und Werte ohne Ziffer meldet shared. */
export function hasRegisterPrefix(form: LegalForm, path: string, value: string): boolean {
  const v = value.trim();
  if (v === '' || !/\d/.test(v)) return true;
  return expectedRegisterPrefixes(form, path).some((prefix) =>
    new RegExp(`^${prefix}\\s*\\d`, 'i').test(v),
  );
}

/**
 * USt-IdNr.: deutsche Nummern genau `DE` + 9 Ziffern, andere Länder wie in
 * shared (zwei Buchstaben, dann 2 bis 12 Zeichen).
 */
export function isPlausibleVatId(value: string): boolean {
  const v = value.replace(/\s+/g, '').toUpperCase();
  if (v === '') return true;
  if (v.startsWith('DE')) return /^DE\d{9}$/.test(v);
  return isValidVatId(v);
}

export type InlineIssue =
  | { code: 'iban' }
  | { code: 'vatId' }
  | { code: 'registerPrefix'; prefixes: string[] };

/**
 * Formatfehler eines Feldes für die Anzeige nach dem Verlassen. Nutzt die
 * Prüfungen aus shared (IBAN-Prüfsumme mod 97, Format der USt-IdNr.) und
 * schärft nur die deutsche USt-IdNr. und das Registerpräfix nach.
 */
export function inlineIssue(profile: IssuerProfile, path: string): InlineIssue | null {
  const raw = getPathValue(profile, path);
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  if (path === 'iban') return isValidIban(raw) ? null : { code: 'iban' };
  if (path === 'vatId') return isPlausibleVatId(raw) ? null : { code: 'vatId' };
  if (path === 'registerNumber' || path === 'generalPartner.registerNumber') {
    return hasRegisterPrefix(profile.legalForm, path, raw)
      ? null
      : { code: 'registerPrefix', prefixes: expectedRegisterPrefixes(profile.legalForm, path) };
  }
  return null;
}
