import { REQUIREMENTS, type IssuerProfile, type LegalForm } from '@saas-instant/shared';

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

  const sections: FieldSection[] = [];

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
  return sections;
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
