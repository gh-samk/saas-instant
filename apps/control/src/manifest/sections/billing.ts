import {
  sectionAsObject,
  isObject,
  optionalTextField,
  textField,
  numberField,
  type ErrorList,
} from '../validation';

/**
 * Rechtsform der Ausstellerin, soweit sie für die Pflichtangaben auf der
 * Rechnung zählt.
 *
 * - `company`: Handelsgesellschaft (KG, GmbH, GmbH & Co. KG …) — Sitz,
 *   Registergericht und Registernummer sind Pflicht (§ 125a HGB).
 * - `sole_proprietor`: Einzelunternehmen / freiberuflich — keine
 *   Registerpflicht auf der Rechnung.
 * - `association`: Verein — ebenso keine Pflicht auf Sitz/Register der Rechnung.
 */
export const ISSUER_LEGAL_FORMS = ['company', 'sole_proprietor', 'association'] as const;
export type IssuerLegalForm = (typeof ISSUER_LEGAL_FORMS)[number];

export interface IssuerManifest {
  /** Fehlt die Angabe, gilt `company` (strengste Prüfung). */
  legalForm: IssuerLegalForm | null;
  name: string;
  address: string;
  taxId: string | null;
  email: string | null;
  bankDetails: string | null;
  /**
   * Optionale strukturierte Angaben für Rechnungsbeleg und Lastschrift. Fehlt
   * eine, gilt (in dieser Reihenfolge) die Umgebungsvariable, der abgeleitete
   * Wert aus `address`/`bankDetails` oder die neutrale Vorgabe.
   */
  street: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  /** Sitz der Gesellschaft (§ 125a HGB), falls abweichend von `city`. */
  seat: string | null;
  phone: string | null;
  contactName: string | null;
  /** SEPA-Gläubiger-Identifikationsnummer. */
  creditorId: string | null;
  bankName: string | null;
  iban: string | null;
  bic: string | null;
  registerCourt: string | null;
  registerNumber: string | null;
  /** Rechtlicher Zusatz (Geschäftsbrief-Pflichtangaben) als Fließtext. */
  legalNotice: string | null;
  /**
   * Persönlich haftende Gesellschafterin (z. B. bei GmbH & Co. KG). Alles
   * optional: Ist `generalPartnerName` nicht gesetzt, druckt die Rechnung
   * keinen entsprechenden Block und verlangt die zugehörigen Angaben nicht.
   */
  generalPartnerName: string | null;
  generalPartnerSeat: string | null;
  generalPartnerRegisterCourt: string | null;
  generalPartnerRegisterNumber: string | null;
  /** Geschäftsführung, mehrere Namen durch Komma getrennt. */
  managingDirectors: string | null;
}

export interface PriceTierManifest {
  /** Technischer Schlüssel der Stufe. */
  key: string;
  label: string;
  /** Preis je Abrechnungszeitraum in Cent. */
  priceCents: number;
  /** Obere Schwelle aktiver Personen (einschließlich); null = nach oben offen. */
  maxPersons: number | null;
  /** Netto je Monat in Cent; Vorgabe: `priceCents`. */
  monthlyCents: number | null;
  /** Netto je Halbjahr in Cent; Vorgabe: 5,5 Monatsraten. */
  halfYearlyCents: number | null;
  /** Netto je Jahr in Cent; Vorgabe: 11 Monatsraten. */
  yearlyCents: number | null;
  /** Einmalige Einrichtung in Cent; Vorgabe: 0. */
  setupCents: number | null;
}

export interface BillingManifest {
  issuer: IssuerManifest;
  tiers: PriceTierManifest[];
  /** Umsatzsteuersatz in Prozent; null = Vorgabe der Preistafel. */
  taxRatePercent: number | null;
  /** Zahlungsziel in Tagen; null = Vorgabe der Preistafel. */
  paymentTermDays: number | null;
  /** Tage für den Durchschnitt aktiver Personen; null = Vorgabe. */
  averageDays: number | null;
  /**
   * Aufbewahrungsfrist festgeschriebener Rechnungen in Jahren (Ende des
   * Festschreibungsjahres + n). Vorgabe 8; die Dauer klärt der Betreiber mit
   * der Steuerberatung.
   */
  retentionYears: number | null;
}

/** Vorgabe der Aufbewahrungsfrist in Jahren. */
export const DEFAULT_RETENTION_YEARS = 8;

const NO_DETAILS_ISSUER = {
  legalForm: null,
  street: null,
  postalCode: null,
  city: null,
  country: null,
  seat: null,
  phone: null,
  contactName: null,
  creditorId: null,
  bankName: null,
  iban: null,
  bic: null,
  registerCourt: null,
  registerNumber: null,
  legalNotice: null,
  generalPartnerName: null,
  generalPartnerSeat: null,
  generalPartnerRegisterCourt: null,
  generalPartnerRegisterNumber: null,
  managingDirectors: null,
};

function optionalNumber(
  o: Record<string, unknown>,
  key: string,
  path: string,
  error: ErrorList,
  min = 0,
): number | null {
  const w = o[key];
  if (w === undefined || w === null) return null;
  return numberField(o, key, path, 0, error, min);
}

export const BILLING_PRESET: BillingManifest = {
  issuer: {
    name: 'Example Company',
    address: 'Example Street 1, 12345 Example City',
    taxId: null,
    email: null,
    bankDetails: null,
    ...NO_DETAILS_ISSUER,
  },
  tiers: [],
  taxRatePercent: null,
  paymentTermDays: null,
  averageDays: null,
  retentionYears: null,
};

export function checkBilling(raw: unknown, error: ErrorList): BillingManifest {
  const o = sectionAsObject(raw, 'billing', error);
  const i = sectionAsObject(o['issuer'], 'billing.issuer', error);
  const v = BILLING_PRESET.issuer;
  const tiers: PriceTierManifest[] = [];
  const rawTiers = o['tiers'];
  if (rawTiers !== undefined && rawTiers !== null) {
    if (!Array.isArray(rawTiers)) {
      error.push('billing.tiers: muss eine Liste sein');
    } else {
      const seen = new Set<string>();
      rawTiers.forEach((s: unknown, idx: number) => {
        const path = `billing.tiers[${idx}]`;
        if (!isObject(s)) {
          error.push(`${path}: muss ein Objekt sein`);
          return;
        }
        const key = textField(s, 'key', path, '', error, { notEmpty: true });
        if (s['key'] === undefined) error.push(`${path}.key: fehlt`);
        if (key && seen.has(key)) error.push(`${path}.key: "${key}" kommt doppelt vor`);
        seen.add(key);
        tiers.push({
          key,
          label: textField(s, 'label', path, key, error),
          priceCents: numberField(s, 'priceCents', path, 0, error),
          maxPersons: optionalNumber(s, 'maxPersons', path, error, 1),
          monthlyCents: optionalNumber(s, 'monthlyCents', path, error),
          halfYearlyCents: optionalNumber(s, 'halfYearlyCents', path, error),
          yearlyCents: optionalNumber(s, 'yearlyCents', path, error),
          setupCents: optionalNumber(s, 'setupCents', path, error),
        });
      });
    }
  }
  const rawLegalForm = optionalTextField(i, 'legalForm', 'billing.issuer', error);
  let legalForm: IssuerLegalForm | null = null;
  if (rawLegalForm !== null && rawLegalForm !== '') {
    if ((ISSUER_LEGAL_FORMS as readonly string[]).includes(rawLegalForm)) {
      legalForm = rawLegalForm as IssuerLegalForm;
    } else {
      error.push(
        `billing.issuer.legalForm: "${rawLegalForm}" ist unbekannt ` +
          `(erlaubt: ${ISSUER_LEGAL_FORMS.join(', ')})`,
      );
    }
  }
  const retentionYears = optionalNumber(o, 'retentionYears', 'billing', error, 1);
  if (retentionYears !== null && (!Number.isInteger(retentionYears) || retentionYears > 30)) {
    error.push('billing.retentionYears: muss eine ganze Zahl von 1 bis 30 sein');
  }
  return {
    issuer: {
      legalForm,
      name: textField(i, 'name', 'billing.issuer', v.name, error, { notEmpty: true }),
      address: textField(i, 'address', 'billing.issuer', v.address, error),
      taxId: optionalTextField(i, 'taxId', 'billing.issuer', error),
      email: optionalTextField(i, 'email', 'billing.issuer', error),
      bankDetails: optionalTextField(i, 'bankDetails', 'billing.issuer', error),
      street: optionalTextField(i, 'street', 'billing.issuer', error),
      postalCode: optionalTextField(i, 'postalCode', 'billing.issuer', error),
      city: optionalTextField(i, 'city', 'billing.issuer', error),
      country: optionalTextField(i, 'country', 'billing.issuer', error),
      seat: optionalTextField(i, 'seat', 'billing.issuer', error),
      phone: optionalTextField(i, 'phone', 'billing.issuer', error),
      contactName: optionalTextField(i, 'contactName', 'billing.issuer', error),
      creditorId: optionalTextField(i, 'creditorId', 'billing.issuer', error),
      bankName: optionalTextField(i, 'bankName', 'billing.issuer', error),
      iban: optionalTextField(i, 'iban', 'billing.issuer', error),
      bic: optionalTextField(i, 'bic', 'billing.issuer', error),
      registerCourt: optionalTextField(i, 'registerCourt', 'billing.issuer', error),
      registerNumber: optionalTextField(i, 'registerNumber', 'billing.issuer', error),
      legalNotice: optionalTextField(i, 'legalNotice', 'billing.issuer', error),
      generalPartnerName: optionalTextField(i, 'generalPartnerName', 'billing.issuer', error),
      generalPartnerSeat: optionalTextField(i, 'generalPartnerSeat', 'billing.issuer', error),
      generalPartnerRegisterCourt: optionalTextField(i, 'generalPartnerRegisterCourt', 'billing.issuer', error),
      generalPartnerRegisterNumber: optionalTextField(i, 'generalPartnerRegisterNumber', 'billing.issuer', error),
      managingDirectors: optionalTextField(i, 'managingDirectors', 'billing.issuer', error),
    },
    tiers,
    taxRatePercent: optionalNumber(o, 'taxRatePercent', 'billing', error),
    paymentTermDays: optionalNumber(o, 'paymentTermDays', 'billing', error),
    averageDays: optionalNumber(o, 'averageDays', 'billing', error, 1),
    retentionYears,
  };
}
