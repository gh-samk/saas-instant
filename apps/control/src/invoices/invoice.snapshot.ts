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
}

export interface RecipientSnapshot {
  recipientName: string;
  /** Mehrzeilig, wie sie im Anschriftenfeld steht. */
  recipientAddress: string;
  recipientEmail: string | null;
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
    recipientEmail:
      company.billingEmail?.trim() ||
      company.contactEmail?.trim() ||
      null,
  };
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
      `BIC ${issuer.bank.bic}`,
    ].join(', '),
  };
}

/**
 * Was einer Rechnung noch fehlt, um ein Beleg zu sein.
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
  invoice: RecipientSnapshot &
    IssuerSnapshot & { linesCount: number },
): string[] {
  const missing: string[] = [];
  const required = (label: string, value: string | null): void => {
    if ((value ?? '').trim() === '') missing.push(label);
  };

  // § 14 Abs. 4 Nr. 1 UStG: vollständiger Name und Anschrift beider Seiten.
  required('Name der Rechnungsempfängerin', invoice.recipientName);
  required('Anschrift der Rechnungsempfängerin', invoice.recipientAddress);
  required('Firmierung der Ausstellerin', invoice.issuerCompanyName);
  required('Anschrift der Ausstellerin', invoice.issuerAddress);
  // § 14 Abs. 4 Nr. 2 UStG: Steuernummer oder USt-IdNr. der Ausstellerin.
  required('Umsatzsteuer-Identifikationsnummer', invoice.issuerVatId);
  // § 125a HGB: Registerangaben der KG und ihrer Komplementärin.
  // [W3]: Der SITZ ist eine eigene Pflichtangabe und nicht durch die
  // Geschäftsanschrift gedeckt.
  required('Sitz der KG', invoice.issuerSeat);
  required('Registergericht der KG', invoice.issuerRegisterCourt);
  required('Handelsregisternummer der KG', invoice.issuerCommercialRegisterA);
  // Die Komplementärin ist OPTIONAL (nicht jede Ausstellerin ist eine
  // GmbH & Co KG). Ist sie genannt, gehören ihre Angaben vollständig dazu.
  if ((invoice.issuerGeneralPartner ?? '').trim() !== '') {
    required('Sitz der Komplementärin', invoice.issuerGeneralPartnerSeat);
    required(
      'Registergericht der Komplementärin',
      invoice.issuerGeneralPartnerRegisterCourt,
    );
    required(
      'Handelsregisternummer der Komplementärin',
      invoice.issuerGeneralPartnerCommercialRegisterB,
    );
    required('Geschäftsführung der Komplementärin', invoice.issuerManagingDirector);
  }
  // Ohne Bankverbindung weiß niemand, wohin gezahlt werden soll. Keine
  // gesetzliche Pflicht, aber eine Rechnung ohne sie ist unbrauchbar.
  required('Bankverbindung', invoice.issuerBankDetails);

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
