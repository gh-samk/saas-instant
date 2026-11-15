import {
  buildIssuerBlocks,
  emptyIssuerProfile,
  type IssuerBlocks,
  type IssuerProfile,
  type LegalForm,
} from '@saas-instant/shared';
import type { IssuerLegalForm } from '../../manifest/sections/billing';
import type { Issuer } from './issuer.config';

/**
 * Abbildung zwischen dem Firmenprofil (`IssuerProfile`, Einstellungen →
 * Firmendaten) und dem `Issuer`, den XML und Dokumentmodell lesen.
 *
 * Reine Funktionen. Das Profil ist die Quelle der Wahrheit; `Issuer` ist nur
 * die Form, in der CII-Erzeugung und Rechnungsdokument es brauchen.
 */

/** Alles, was zur Darstellung eines Ausstellers auf dem Beleg gehört. */
export interface DocumentIssuerExtras {
  /** Briefkopf-, Kontakt-, Bank- und Pflichtangabenzeilen für das Layout. */
  blocks: IssuerBlocks;
  /** `data:`-URI des Logos oder `null`. */
  logoDataUri: string | null;
  /** Akzentfarbe `#rrggbb` oder `null` (Renderer nimmt dann seine Vorgabe). */
  accentColor: string | null;
}

/** Der Aussteller im Dokumentmodell: Daten plus Darstellung. */
export type DocumentIssuer = Issuer & DocumentIssuerExtras;

/** Aussteller samt Profil, Logo und Akzentfarbe zu einem Zeitpunkt. */
export interface CurrentIssuer {
  issuer: Issuer;
  profile: IssuerProfile;
  accentColor: string | null;
  logoDataUri: string | null;
}

/** Manifest-Rechtsform → Rechtsform des Profils. */
export function legalFormFromManifest(
  form: IssuerLegalForm,
  hasGeneralPartner: boolean,
): LegalForm {
  switch (form) {
    case 'company':
      return hasGeneralPartner ? 'gmbh_co_kg' : 'gmbh';
    case 'sole_proprietor':
      return 'einzelunternehmen';
    case 'association':
      return 'ev';
  }
}

const COUNTRY_NAMES: Record<string, string> = { DE: 'Deutschland' };

/** Startwerte (Manifest/Umgebung) → Profil. Unbekannte Felder bleiben leer. */
export function profileFromIssuer(issuer: Issuer): IssuerProfile {
  const p = emptyIssuerProfile(issuer.legalForm);
  const country = issuer.address.country.trim();
  const gp = issuer.generalPartner;
  const isCompanyWithPerson = ['gmbh', 'ug', 'eg', 'ev'].includes(
    issuer.legalForm,
  );
  return {
    ...p,
    name: issuer.name,
    street: issuer.address.street,
    postalCode: issuer.address.postalCode,
    city: issuer.address.city,
    country: COUNTRY_NAMES[country.toUpperCase()] ?? (country || p.country),
    seat: issuer.seat,
    registerCourt: issuer.registerCourt,
    registerNumber: issuer.registerIdentifier,
    registered: issuer.registerIdentifier.trim() !== '',
    managingPersons: isCompanyWithPerson ? [...gp.managingDirector] : [],
    generalPartner:
      issuer.legalForm === 'gmbh_co_kg'
        ? {
            name: gp.name,
            seat: gp.seat,
            registerCourt: gp.registerCourt,
            registerNumber: gp.registerIdentifier,
            managingDirectors: [...gp.managingDirector],
            supervisoryChair: '',
          }
        : p.generalPartner,
    vatId: issuer.vatId,
    taxNumber: issuer.taxNumber ?? '',
    phone: issuer.contact.phone,
    email: issuer.contact.email,
    bankName: issuer.bank.institution,
    iban: issuer.bank.iban,
    bic: issuer.bank.bic,
    creditorId: issuer.creditorId,
  };
}

/** Ansprechperson für BT-41: Inhaberin, erste Person der Leitung, sonst Firma. */
function contactName(p: IssuerProfile): string {
  const first = (list: string[]): string =>
    list.map((x) => x.trim()).find((x) => x !== '') ?? '';
  return (
    p.ownerName.trim() ||
    first(p.managingPersons) ||
    first(p.partners) ||
    first(p.generalPartner.managingDirectors) ||
    p.name.trim()
  );
}

/** Profil → `Issuer` (XML, Dokumentmodell). BT-33 = Pflichtzeilen mit „ | ". */
export function issuerFromProfile(p: IssuerProfile): Issuer {
  const blocks = buildIssuerBlocks(p);
  const gp = p.generalPartner;
  return {
    legalForm: p.legalForm,
    name: p.name.trim(),
    address: {
      street: p.street.trim(),
      postalCode: p.postalCode.trim(),
      city: p.city.trim(),
      country: p.country.trim(),
    },
    seat: p.seat.trim() || p.city.trim(),
    vatId: p.vatId.replace(/\s+/g, ''),
    taxNumber: p.taxNumber.trim(),
    creditorId: p.creditorId.trim(),
    registerIdentifier: p.registerNumber.trim(),
    registerCourt: p.registerCourt.trim(),
    generalPartner: {
      name: gp.name.trim(),
      seat: gp.seat.trim(),
      registerCourt: gp.registerCourt.trim(),
      registerIdentifier: gp.registerNumber.trim(),
      managingDirector:
        p.legalForm === 'gmbh_co_kg'
          ? gp.managingDirectors.map((x) => x.trim()).filter((x) => x !== '')
          : [],
    },
    contact: {
      name: contactName(p),
      phone: p.phone.trim(),
      email: p.email.trim(),
    },
    bank: {
      institution: p.bankName.trim(),
      iban: p.iban.replace(/\s+/g, '').toUpperCase(),
      bic: p.bic.replace(/\s+/g, ''),
    },
    legalAddition: blocks.legalLines.join(' | '),
  };
}

/** Dokument-Aussteller aus einem `Issuer` (Profil abgeleitet, ohne Logo). */
export function documentIssuerFrom(
  issuer: Issuer,
  extras: Partial<DocumentIssuerExtras> = {},
): DocumentIssuer {
  return {
    ...issuer,
    blocks: buildIssuerBlocks(profileFromIssuer(issuer)),
    logoDataUri: null,
    accentColor: null,
    ...extras,
  };
}

/** Dokument-Aussteller aus Profil, Logo und Farbe. */
export function documentIssuerFromCurrent(c: CurrentIssuer): DocumentIssuer {
  return {
    ...c.issuer,
    blocks: buildIssuerBlocks(c.profile),
    logoDataUri: c.logoDataUri,
    accentColor: c.accentColor,
  };
}

/** Das aktuelle Profil samt `Issuer`, ohne Logo und Farbe. */
export function currentFromProfile(
  profile: IssuerProfile,
  accentColor: string | null,
  logoDataUri: string | null,
): CurrentIssuer {
  return { issuer: issuerFromProfile(profile), profile, accentColor, logoDataUri };
}

/**
 * Darstellung des Ausstellers, wie sie beim Festschreiben in
 * `Invoice.issuerLayout` eingefroren wird (GoBD: danach unveränderlich).
 */
export interface IssuerLayoutSnapshot {
  legalForm: LegalForm;
  blocks: IssuerBlocks;
  logoDataUri: string | null;
  accentColor: string | null;
  taxNumber: string;
  legalAddition: string;
}

/** Schnappschuss der Darstellung aus dem aktuellen Profil (beim Festschreiben). */
export function issuerLayoutSnapshot(c: CurrentIssuer): IssuerLayoutSnapshot {
  const issuer = documentIssuerFromCurrent(c);
  return {
    legalForm: issuer.legalForm,
    blocks: issuer.blocks,
    logoDataUri: issuer.logoDataUri,
    accentColor: issuer.accentColor,
    taxNumber: issuer.taxNumber ?? '',
    legalAddition: issuer.legalAddition,
  };
}

/** Liest den gespeicherten Schnappschuss; `null`, wenn fehlend oder unbrauchbar (Altdaten). */
export function parseIssuerLayout(value: unknown): IssuerLayoutSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const b = v.blocks as Record<string, unknown> | undefined;
  const isLines = (x: unknown): boolean =>
    Array.isArray(x) && x.every((l) => typeof l === 'string');
  if (
    typeof v.legalForm !== 'string' ||
    typeof b !== 'object' ||
    b === null ||
    !isLines(b.companyLines) ||
    !isLines(b.contactLines) ||
    !isLines(b.bankLines) ||
    !isLines(b.legalLines) ||
    typeof v.legalAddition !== 'string'
  ) {
    return null;
  }
  return {
    legalForm: v.legalForm as LegalForm,
    blocks: b as unknown as IssuerBlocks,
    logoDataUri: typeof v.logoDataUri === 'string' ? v.logoDataUri : null,
    accentColor: typeof v.accentColor === 'string' ? v.accentColor : null,
    taxNumber: typeof v.taxNumber === 'string' ? v.taxNumber : '',
    legalAddition: v.legalAddition,
  };
}
