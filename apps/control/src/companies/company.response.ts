import type {
  ConsentStatus,
  Source,
  InstanceStatus,
  CompanyStatus,
  Prisma,
  PaymentMethod,
  PaymentInterval,
} from '.prisma/control-client';
import { dateStringFromDate } from '@saas-instant/shared';

/**
 * Eine Organisation, wie sie über die API geht.
 *
 * Alle FACHLICHEN Datumsangaben sind Tagesdaten `YYYY-MM-DD` (Regel 1 der
 * Projektkonventionen) — niemals ISO-Zeitstempel. `createdAt` und `updatedAt` sind
 * technische Zeitstempel und bleiben ISO; sie sind kein fachliches Datum,
 * sondern sagen, wann der Datensatz angefasst wurde.
 *
 * `customAmount` geht als ZEICHENKETTE hinaus, nicht als Zahl: ein
 * Decimal(10,2) durch `number` zu schicken, hieße Geldbeträge über
 * Gleitkomma zu reichen.
 */
export interface CompanyResponse {
  id: string;
  name: string;
  legalForm: string | null;
  website: string | null;

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

  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactRole: string | null;

  deputyName: string | null;
  deputyEmail: string | null;
  deputyPhone: string | null;
  deputyRole: string | null;

  status: CompanyStatus;
  lastStatusChangeAt: string | null;

  priceTier: string | null;
  paymentInterval: PaymentInterval | null;
  /** Lastschrift oder Ueberweisung. Bei `monatlich` nur `directDebit`. */
  paymentMethod: PaymentMethod | null;
  /**
   * Sind Zahlungsdaten hinterlegt? — Statt der Daten selbst.
   *
   * IBAN, SEPA-Mandatsreferenz und der abweichende Betrag stehen NICHT in
   * dieser Antwort ([W4]). Wer sie sehen will, geht über
   * `POST …/zahlungsdaten/anzeigen` und weist sich dabei ein zweites Mal aus.
   * Vorher genügte ein 25 Stunden altes Sitzungs-Cookie, um an einer
   * gewöhnlichen Detailansicht die Bankverbindung mitzulesen.
   */
  paymentDetailsStored: boolean;

  pilotDecisionDate: string | null;
  reviewDueDate: string | null;
  /** Quittung der Überprüfung; `null` heißt „steht noch offen" ([K2]). */
  reviewDoneAt: string | null;
  instanceStartDate: string | null;

  newsletterConsentStatus: ConsentStatus | null;
  source: Source | null;
  notes: string | null;

  createdAt: string;
  updatedAt: string;
}

/** Kurzform für die Liste — bewusst ohne Bank- und Rechnungsdaten. */
export interface CompanyShort {
  id: string;
  name: string;
  status: CompanyStatus;
  city: string | null;
  contactName: string | null;
  contactEmail: string | null;
  reviewDueDate: string | null;
  lastStatusChangeAt: string | null;
  createdAt: string;
  /**
   * Status der Kundeninstanz — `null`, wenn es keine gibt.
   *
   * Steht in der Liste, seit das Redesign eine eigene Spalte dafuer hat. Sie
   * beantwortet die haeufigste Frage beim Ueberfliegen: Laeuft bei denen
   * ueberhaupt schon etwas?
   */
  instanceStatus: InstanceStatus | null;
  /**
   * Summe der noch offenen Rechnungsbetraege in Cent, `0` wenn nichts offen
   * ist.
   *
   * OFFEN HEISST HIER GENAU DAS, was `paymentStateFrom` so nennt: nicht
   * Entwurf, nicht storniert, nicht ausgeglichen. Die Ableitung wird NICHT
   * hier wiederholt, sondern aufgerufen — sonst zeigten Liste und
   * Rechnungsansicht eines Tages verschiedene Betraege.
   */
  openAmountCent: number;
  /** Ist davon etwas ueberfaellig? Faerbt den Betrag rot. */
  openOverdue: boolean;
}

/** Eine aus der Datenbank gelesene Organisation, wie Prisma sie liefert. */
export interface CompanyRow {
  id: string;
  name: string;
  legalForm: string | null;
  website: string | null;
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
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactRole: string | null;
  deputyName: string | null;
  deputyEmail: string | null;
  deputyPhone: string | null;
  deputyRole: string | null;
  status: CompanyStatus;
  lastStatusChangeAt: Date | null;
  priceTier: string | null;
  customAmount: Prisma.Decimal | null;
  paymentInterval: PaymentInterval | null;
  /** Lastschrift oder Ueberweisung. Bei `monatlich` nur `directDebit`. */
  paymentMethod: PaymentMethod | null;
  sepaMandateReference: string | null;
  sepaMandateDate: Date | null;
  iban: string | null;
  pilotDecisionDate: Date | null;
  reviewDueDate: Date | null;
  reviewDoneAt: Date | null;
  instanceStartDate: Date | null;
  newsletterConsentStatus: ConsentStatus | null;
  source: Source | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Tagesdatum aus einem `@db.Date`, oder null. */
export function dayOrNull(value: Date | null): string | null {
  return value === null ? null : dateStringFromDate(value);
}

export function asResponse(row: CompanyRow): CompanyResponse {
  return {
    id: row.id,
    name: row.name,
    legalForm: row.legalForm,
    website: row.website,
    street: row.street,
    houseNumber: row.houseNumber,
    postalCode: row.postalCode,
    city: row.city,
    country: row.country,
    billingName: row.billingName,
    billingStreet: row.billingStreet,
    billingHouseNumber: row.billingHouseNumber,
    billingPostalCode: row.billingPostalCode,
    billingCity: row.billingCity,
    billingCountry: row.billingCountry,
    billingEmail: row.billingEmail,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    contactRole: row.contactRole,
    deputyName: row.deputyName,
    deputyEmail: row.deputyEmail,
    deputyPhone: row.deputyPhone,
    deputyRole: row.deputyRole,
    status: row.status,
    lastStatusChangeAt: dayOrNull(row.lastStatusChangeAt),
    priceTier: row.priceTier,
    paymentInterval: row.paymentInterval,
    paymentMethod: row.paymentMethod,
    paymentDetailsStored:
      row.iban !== null ||
      row.sepaMandateReference !== null ||
      row.customAmount !== null,
    pilotDecisionDate: dayOrNull(row.pilotDecisionDate),
    reviewDueDate: dayOrNull(row.reviewDueDate),
    reviewDoneAt: dayOrNull(row.reviewDoneAt),
    instanceStartDate: dayOrNull(row.instanceStartDate),
    newsletterConsentStatus: row.newsletterConsentStatus,
    source: row.source,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Die Zahlungsdaten — nur über den geschützten Endpunkt.
 *
 * Getrennter Typ, damit sich nicht versehentlich jemand aus Bequemlichkeit
 * `CompanyResponse` um ein IBAN-Feld erweitert.
 */
export interface PaymentDetailsResponse {
  companyId: string;
  iban: string | null;
  sepaMandateReference: string | null;
  sepaMandateDate: string | null;
  customAmount: string | null;
}

export function asPaymentDetails(row: {
  id: string;
  iban: string | null;
  sepaMandateReference: string | null;
  sepaMandateDate: Date | null;
  customAmount: Prisma.Decimal | null;
}): PaymentDetailsResponse {
  return {
    companyId: row.id,
    iban: row.iban,
    sepaMandateReference: row.sepaMandateReference,
    sepaMandateDate: dayOrNull(row.sepaMandateDate),
    customAmount:
      row.customAmount === null
        ? null
        : row.customAmount.toFixed(2),
  };
}

/**
 * Eine Anfrage über das Formular der Webseite – was angefragt wurde und was
 * darauf passierte. Eigene Antwort, NICHT Teil von `CompanyResponse`:
 * Sonst verschwände sie nach jedem Bearbeiten aus der Detailseite und
 * tauchte in jedem Audit-Vergleich auf.
 */
export interface InquiryEntry {
  kind: 'demo' | 'pilot';
  /** `null` = vor dem 15.09.2026 eingegangen, Ergebnis nicht erfasst. */
  outcome:
    | 'credentials_sent'
    | 'confirmation_sent'
    | 'already_triggered'
    | 'quota_exhausted'
    | 'send_failed'
    | null;
  receivedAt: string;
}

export interface InquiriesResponse {
  inquiries: InquiryEntry[];
}
