import type { BuyerType } from '.prisma/control-client';
import type { Issuer } from './document/issuer.config';

/**
 * DER SCHNAPPSCHUSS — R2, wörtlich: „Eine festgeschriebene Rechnung ist ein
 * Schnappschuss: alle Werte werden zum Zeitpunkt des Festschreibens
 * hineinkopiert. Niemals per Relation zur Organisation gerendert."
 *
 * Die Spalten dafür stehen seit der Init-Migration an `Rechnung`. Hier steht,
 * WIE sie gefüllt werden — und die Prüfung, ohne die sie unvollständig blieben.
 *
 * DIE RELATION ZUR ORGANISATION BLEIBT, aber nur für die Zuordnung: filtern,
 * auswerten, „welche Rechnungen gehören zu dieser Kundin". Für die
 * Darstellung wird sie nie benutzt. Genau deshalb überlebt eine Rechnung die
 * Kontaktdatenlöschung aus Etappe 2 unbeschadet: Der Fremdschlüssel steht auf
 * `onDelete: Restrict`, und der Beleg trägt seine Angaben selbst.
 */

/** Die Felder der Organisation, aus denen der Empfängerteil entsteht. */
export interface CompanyForSnapshot {
  name: string;
  street: string | null;
  houseNumber: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  billingName: string | null;
  billingStreet: string | null;
  billingHouseNumber: string | null;
  billingPostalCode: string | null;
  billingCity: string | null;
  billingCountry: string | null;
  billingEmail: string | null;
  contactEmail: string | null;
  /** E-Rechnung: Art der Empfängerin; fehlt sie, gilt `business`. */
  buyerType?: BuyerType;
  vatId?: string | null;
  buyerReference?: string | null;
  electronicAddress?: string | null;
  electronicAddressScheme?: string | null;
}

export interface RecipientSnapshot {
  recipientName: string;
  /** Mehrzeilig, wie sie im Anschriftenfeld steht. */
  recipientAddress: string;
  recipientEmail: string | null;
  recipientBuyerType: BuyerType;
  /** BT-48. */
  recipientVatId: string | null;
  /** BT-10: Leitweg-ID bzw. Käuferreferenz. */
  recipientBuyerReference: string | null;
  /** BT-49 samt Schema (`EM`, `0204`, …). */
  recipientElectronicAddress: string | null;
  recipientElectronicAddressScheme: string | null;
}

export interface IssuerSnapshot {
  issuerCompanyName: string;
  issuerAddress: string;
  issuerVatId: string | null;
  issuerSeat: string | null;
  issuerRegisterCourt: string | null;
  issuerCommercialRegisterA: string | null;
  issuerGeneralPartner: string | null;
  issuerGeneralPartnerSeat: string | null;
  issuerGeneralPartnerRegisterCourt: string | null;
  issuerGeneralPartnerCommercialRegisterB: string | null;
  issuerManagingDirector: string | null;
  issuerBankDetails: string | null;
  /** Rückfrageweg (BR-DE-2), eingefroren wie jede andere Angabe. */
  issuerContactName: string | null;
  issuerContactPhone: string | null;
  issuerContactEmail: string | null;
  /** Bank STRUKTURIERT — das XML liest sie von hier, nicht per Regex. */
  issuerIban: string | null;
  issuerBic: string | null;
  issuerBankName: string | null;
}

function row(...parts: (string | null)[]): string {
  return parts
    .map((part) => part?.trim() ?? '')
    .filter((part) => part !== '')
    .join(' ');
}

/**
 * Empfängerteil aus der Organisation.
 *
 * DIE RECHNUNGSADRESSE STICHT DIE ANSCHRIFT, aber nur als Ganzes: Wer eine
 * abweichende Rechnungsadresse pflegt, will nicht, dass einzelne Felder aus
 * der Hausanschrift dazwischenrutschen. Ein halb gefülltes Rechnungsfeld wäre
 * sonst eine Anschrift, die es nirgends gibt.
 */
export function recipientSnapshot(
  company: CompanyForSnapshot,
): RecipientSnapshot {
  const ownBillingAddress =
    (company.billingStreet ?? '').trim() !== '' ||
    (company.billingPostalCode ?? '').trim() !== '' ||
    (company.billingCity ?? '').trim() !== '';

  const recipientEmail =
    company.billingEmail?.trim() || company.contactEmail?.trim() || null;

  const address = ownBillingAddress
    ? {
        street: row(company.billingStreet, company.billingHouseNumber),
        postalCodeCity: row(company.billingPostalCode, company.billingCity),
        country: company.billingCountry,
      }
    : {
        street: row(company.street, company.houseNumber),
        postalCodeCity: row(company.postalCode, company.city),
        country: company.country,
      };

  return {
    recipientName:
      (company.billingName ?? '').trim() !== ''
        ? (company.billingName as string).trim()
        : company.name.trim(),
    recipientAddress: [address.street, address.postalCodeCity, address.country?.trim()]
      .filter((part): part is string => (part ?? '') !== '')
      .join('\n'),
    recipientEmail,
    recipientBuyerType: company.buyerType ?? 'business',
    recipientVatId: clean(company.vatId),
    recipientBuyerReference: clean(company.buyerReference),
    // BT-49 ist bei XRechnung Pflicht: Ohne eigene Angabe dient die
    // Rechnungs-E-Mail (Schema EM).
    recipientElectronicAddress: clean(company.electronicAddress) ?? recipientEmail,
    recipientElectronicAddressScheme:
      clean(company.electronicAddress) !== null
        ? clean(company.electronicAddressScheme) ??
          (company.electronicAddress?.includes('@') ? 'EM' : null)
        : recipientEmail !== null
          ? 'EM'
          : null,
  };
}

function clean(value: string | null | undefined): string | null {
  const t = value?.trim() ?? '';
  return t === '' ? null : t;
}

/** Ausstellerteil aus der geltenden Konfiguration. */
export function issuerSnapshot(
  issuer: Issuer,
): IssuerSnapshot {
  return {
    issuerCompanyName: issuer.name,
    issuerAddress: [
      issuer.address.street,
      `${issuer.address.postalCode} ${issuer.address.city}`,
      issuer.address.country,
    ].join('\n'),
    issuerSeat: issuer.seat,
    issuerVatId: issuer.vatId,
    issuerRegisterCourt: issuer.registerCourt,
    issuerCommercialRegisterA: issuer.registerIdentifier,
    issuerGeneralPartner: issuer.generalPartner.name,
    issuerGeneralPartnerSeat: issuer.generalPartner.seat,
    issuerGeneralPartnerRegisterCourt:
      issuer.generalPartner.registerCourt,
    issuerGeneralPartnerCommercialRegisterB: issuer.generalPartner.registerIdentifier,
    issuerManagingDirector:
      issuer.generalPartner.managingDirector.join(', '),
    issuerBankDetails: [
      issuer.bank.institution,
      `IBAN ${issuer.bank.iban}`,
      issuer.bank.bic ? `BIC ${issuer.bank.bic}` : '',
    ]
      .filter((part) => part !== '')
      .join(', '),
    issuerContactName: issuer.contact.name,
    issuerContactPhone: issuer.contact.phone,
    issuerContactEmail: issuer.contact.email,
    issuerIban: issuer.bank.iban.replace(/\s+/g, ''),
    issuerBic: issuer.bank.bic,
    issuerBankName: issuer.bank.institution,
  };
}

/**
 * Was einer Rechnung noch fehlt, um ein Beleg zu sein — Empfängerseite und
 * Posten.
 *
 * DIE ANGABEN DER AUSSTELLERIN prüft nicht diese Funktion, sondern
 * `validateIssuerProfile` aus `@saas-instant/shared` je Rechtsform (Fehler
 * `issuer_incomplete`, Einstellungen → Firmendaten).
 *
 * GEPRÜFT WIRD BEIM FESTSCHREIBEN, nicht beim Entwurf. Ein Entwurf darf
 * unvollständig sein — man legt ihn an, während man die Adresse noch sucht.
 * Ein festgeschriebener Beleg darf es nicht: § 14 Abs. 4 UStG zählt die
 * Pflichtangaben abschließend auf, und eine fehlende fällt sonst erst bei der
 * Betriebsprüfung auf, wenn sich nichts mehr ändern lässt.
 *
 * Nicht geprüft werden hier Rechnungsnummer und Ausstellungsdatum: Die Nummer
 * vergibt erst das Festschreiben selbst, das Datum ist eine Pflichtspalte.
 */
export function missingMandatoryDetails(
  invoice: RecipientSnapshot & { linesCount: number },
): string[] {
  const missing: string[] = [];
  const required = (label: string, value: string | null): void => {
    if ((value ?? '').trim() === '') missing.push(label);
  };

  // § 14 Abs. 4 Nr. 1 UStG: vollständiger Name und Anschrift der Empfängerin.
  required('Name der Rechnungsempfängerin', invoice.recipientName);
  required('Anschrift der Rechnungsempfängerin', invoice.recipientAddress);

  // Eine Behörde erwartet ihre Leitweg-ID (BT-10). Ohne sie kann die
  // Rechnung dort nicht zugeordnet werden und wird abgewiesen.
  if (invoice.recipientBuyerType === 'authority') {
    required(
      'Leitweg-ID der Behörde (Käuferreferenz)',
      invoice.recipientBuyerReference,
    );
  }

  // § 14 Abs. 4 Nr. 5 UStG: Menge und Art der Leistung.
  if (invoice.linesCount < 1) missing.push('Mindestens ein Rechnungsposten');

  // Die Anschrift muss mehr als eine Zeile hergeben — ein bloßer Ortsname
  // ohne Straße ist keine Anschrift.
  if (
    invoice.recipientAddress.trim() !== '' &&
    invoice.recipientAddress.split('\n').filter((z) => z.trim() !== '').length < 2
  ) {
    missing.push('Vollständige Anschrift der Rechnungsempfängerin (Straße, PLZ, Ort)');
  }

  return missing;
}
