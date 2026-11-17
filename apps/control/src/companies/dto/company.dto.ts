import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsHttpUrl } from '../../common/validators/is-http-url';
import type {
  BuyerType,
  ConsentStatus,
  Source,
  CompanyStatus,
  PaymentMethod,
  PaymentInterval,
} from '.prisma/control-client';
import { IsCalendarDate } from '../../common/validators/is-calendar-date';

/**
 * Die Werte der Enums als Laufzeit-Listen.
 *
 * Bewusst als Konstante und nicht über den generierten Prisma-Namespace:
 * `class-validator` braucht die Liste zur LAUFZEIT, `import type` liefert sie
 * nicht. Der Typ oben stellt sicher, dass die Liste vollständig bleibt — fehlt
 * ein Wert, meldet es der Typprüfer.
 */
export const COMPANY_STATUS: readonly CompanyStatus[] = [
  'inquiry',
  'trial',
  'paying',
  'exempt',
  'ended',
];

export const PaymentMethods: readonly PaymentMethod[] = [
  'direct_debit',
  'bank_transfer',
];

export const PaymentIntervals: readonly PaymentInterval[] = [
  'yearly',
  'half_yearly',
  'monthly',
];

export const Sources: readonly Source[] = [
  'form',
  'phone',
  'referral',
  'event',
];

/** Art der Rechnungsempfängerin (E-Rechnung): Unternehmen, Behörde, Privatperson. */
export const BuyerTypes: readonly BuyerType[] = [
  'business',
  'authority',
  'consumer',
];

/**
 * Schemata der elektronischen Adresse (BT-49, ISO 6523 bzw. EAS-Liste).
 * `EM` = E-Mail, `0204` = Leitweg-ID, `9930` = deutsche USt-IdNr.
 */
export const ElectronicAddressSchemes = ['EM', '0204', '9930', '0088', '0060'];

export const CONSENT_STATUS: readonly ConsentStatus[] = [
  'unconfirmed',
  'confirmed',
  'unsubscribed',
  'hard_bounced',
  'spam_reported',
];

/**
 * Stammdaten einer Organisation.
 *
 * NICHT enthalten und das mit Absicht:
 * - `status` — der Wechsel läuft über `POST …/status`, weil jeder Wechsel eine
 *   systemerzeugte Notiz und einen Audit-Eintrag nach sich zieht. Beim ANLEGEN
 *   ist er erlaubt (siehe `CompanyCreateDto`): dort gibt es keinen
 *   Wechsel, nur einen Anfangswert.
 * - `ansprechpartnerin*` beim Bearbeiten — der Wechsel läuft über
 *   `POST …/ansprechpartnerin`, weil der Datensatz ERSETZT wird und dabei die
 *   Notiz „Ansprechpartnerin gewechselt: … → …" entsteht. Beim Anlegen ist er
 *   erlaubt, dort wird niemand abgelöst.
 * - `lastStatusChangeAt` — setzt der Statuswechsel selbst.
 */
export class CompanyMasterDataDto {
  @IsOptional() @IsString() @MaxLength(120) legalForm?: string;
  @IsOptional() @IsString() @MaxLength(300) @IsHttpUrl() website?: string;

  @IsOptional() @IsString() @MaxLength(200) street?: string;
  @IsOptional() @IsString() @MaxLength(20) houseNumber?: string;
  @IsOptional() @IsString() @MaxLength(10) postalCode?: string;
  @IsOptional() @IsString() @MaxLength(120) city?: string;
  @IsOptional() @IsString() @MaxLength(120) country?: string;

  @IsOptional() @IsString() @MaxLength(200) billingName?: string;
  @IsOptional() @IsString() @MaxLength(200) billingStreet?: string;
  @IsOptional() @IsString() @MaxLength(20) billingHouseNumber?: string;
  @IsOptional() @IsString() @MaxLength(10) billingPostalCode?: string;
  @IsOptional() @IsString() @MaxLength(120) billingCity?: string;
  @IsOptional() @IsString() @MaxLength(120) billingCountry?: string;
  @IsOptional()
  @IsEmail({}, { message: 'Bitte eine gültige Rechnungs-E-Mail angeben.' })
  @MaxLength(200)
  billingEmail?: string;

  @IsOptional() @IsString() @MaxLength(200) deputyName?: string;
  @IsOptional()
  @IsEmail({}, { message: 'Bitte eine gültige E-Mail der Stellvertretung angeben.' })
  @MaxLength(200)
  deputyEmail?: string;
  @IsOptional() @IsString() @MaxLength(60) deputyPhone?: string;
  @IsOptional() @IsString() @MaxLength(120) deputyRole?: string;

  @IsOptional() @IsString() @MaxLength(60) priceTier?: string;

  // --- E-Rechnung (ZUGFeRD / XRechnung) -----------------------------------
  /** Unternehmen (Vorgabe), Behörde (Leitweg-ID Pflicht) oder Privatperson. */
  @IsOptional() @IsIn(BuyerTypes as string[]) buyerType?: BuyerType;
  /** Umsatzsteuer-Identifikationsnummer der Empfängerin (BT-48). */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{2}[0-9A-Za-z+*.]{2,12}$/, {
    message: 'Bitte eine gültige USt-IdNr. angeben (z. B. DE123456789).',
  })
  vatId?: string;
  /** Leitweg-ID bzw. Käuferreferenz (BT-10). */
  @IsOptional() @IsString() @MaxLength(46) buyerReference?: string;
  /** Elektronische Adresse der Empfängerin (BT-49). */
  @IsOptional() @IsString() @MaxLength(200) electronicAddress?: string;
  @IsOptional()
  @IsIn(ElectronicAddressSchemes, {
    message: 'Unbekanntes Schema der elektronischen Adresse.',
  })
  electronicAddressScheme?: string;
  @IsOptional() @IsIn(PaymentIntervals as string[]) paymentInterval?: PaymentInterval;

  /**
   * Lastschrift oder Ueberweisung.
   *
   * DIE REGEL DAZU STEHT IM DIENST, nicht hier: „monatlich nur per
   * Lastschrift" verbindet ZWEI Felder, und ein Dekorator sieht immer nur
   * eines. Sie hier zu prüfen hiesse, sie halb zu prüfen.
   */
  @IsOptional() @IsIn(PaymentMethods as string[]) paymentMethod?: PaymentMethod;

  // `iban`, `sepaMandateReference`, `sepaMandateDate` und
  // `customAmount` stehen hier ABSICHTLICH NICHT ([W6]/[W4]).
  //
  // Sie laufen über `PATCH …/zahlungsdaten` am
  // `CompanyConfidentialController`, hinter dem ZweitfaktorGuard. Die
  // Begründung, mit der die übrigen Routen ohne zweiten Faktor auskommen —
  // „Stammdaten zu ändern ist innerhalb der Sitzung folgenlos" — trägt für
  // eine Bankverbindung nicht: Mit einem 25 Stunden alten Cookie war sie
  // lesbar UND änderbar.

  @IsOptional() @IsCalendarDate() instanceStartDate?: string;

  @IsOptional()
  @IsIn(CONSENT_STATUS as string[])
  newsletterConsentStatus?: ConsentStatus;
  @IsOptional() @IsIn(Sources as string[]) source?: Source;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
}

/**
 * Beim Anlegen sind Name Pflicht und Anfangsstatus sowie Ansprechpartnerin
 * erlaubt.
 *
 * `name` steht in beiden abgeleiteten Klassen einzeln und nicht in der
 * gemeinsamen Oberklasse: Er ist hier pflichtig und beim Bearbeiten optional.
 * Ein überschriebenes Feld verlöre in TypeScript entweder die Prüfregeln oder
 * den Wert (TS2612).
 */
export class CompanyCreateDto extends CompanyMasterDataDto {
  @IsString()
  @IsNotEmpty({ message: 'Der Name der Organisation ist erforderlich.' })
  @MaxLength(200)
  name!: string;

  @IsOptional() @IsIn(COMPANY_STATUS as string[]) status?: CompanyStatus;

  @IsOptional() @IsString() @MaxLength(200) contactName?: string;
  @IsOptional()
  @IsEmail({}, { message: 'Bitte eine gültige E-Mail der Ansprechpartnerin angeben.' })
  @MaxLength(200)
  contactEmail?: string;
  @IsOptional() @IsString() @MaxLength(60) contactPhone?: string;
  @IsOptional() @IsString() @MaxLength(120) contactRole?: string;
}

/** Beim Bearbeiten sind alle Felder optional; Verbotenes steht gar nicht drin. */
export class CompanyUpdateDto extends CompanyMasterDataDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Der Name darf nicht leer sein.' })
  @MaxLength(200)
  name?: string;
}

/**
 * Der Wechsel der Ansprechpartnerin ERSETZT den Datensatz, er ergänzt ihn
 * nicht: nicht gesendete Felder werden geleert, nicht stehen gelassen.
 */
export class ContactPersonChangeDto {
  @IsString()
  @IsNotEmpty({ message: 'Der Name der neuen Ansprechpartnerin ist erforderlich.' })
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsEmail({}, { message: 'Bitte eine gültige E-Mail-Adresse angeben.' })
  @MaxLength(200)
  email?: string;

  @IsOptional() @IsString() @MaxLength(60) phone?: string;
  @IsOptional() @IsString() @MaxLength(120) functionValue?: string;
}

/** Statuswechsel von Hand. */
export class StatusChangeDto {
  @IsIn(COMPANY_STATUS as string[], {
    message: 'Unbekannter Status.',
  })
  status!: CompanyStatus;
}

/** Filter der Liste. */
export class CompanyListDto {
  /**
   * Einer oder mehrere Status, kommagetrennt.
   *
   * Ein einzelner Status ohne Komma bleibt gueltig — die Zerlegung liefert
   * dann eine Liste mit einem Eintrag.
   */
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part !== '')
      : value,
  )
  @IsArray()
  @ArrayMaxSize(COMPANY_STATUS.length)
  @IsIn(COMPANY_STATUS as string[], { each: true })
  status?: CompanyStatus[];

  @IsOptional() @IsString() @MaxLength(200) search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  perPage?: number;
}

/**
 * Zahlungsdaten — der VERTRAULICHE Teil einer Organisation.
 *
 * Eigenes DTO an einem eigenen, mit `SecondFactorGuard` geschützten Endpunkt.
 * `currentPassword` und `totpCode` sind der Nachweis, den der Guard aus dem
 * Body liest; sie müssen deshalb im DTO stehen, sonst weist die ValidationPipe
 * sie als unbekannte Felder ab.
 */
export class PaymentDetailsDto {
  @IsOptional() @IsString() @MaxLength(40) iban?: string;
  @IsOptional() @IsString() @MaxLength(60) sepaMandateReference?: string;
  @IsOptional() @IsCalendarDate() sepaMandateDate?: string;
  @IsOptional()
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'Der Betrag darf höchstens zwei Nachkommastellen haben.' },
  )
  @Min(0)
  @Max(99_999_999)
  customAmount?: number;

  @IsOptional() @IsString() @MaxLength(1024) currentPassword?: string;
  @IsOptional() @IsString() @MaxLength(6) totpCode?: string;
}

/** Nur der Nachweis, ohne weitere Angaben (Anzeigen, Löschen). */
export class EvidenceDto {
  @IsOptional() @IsString() @MaxLength(1024) currentPassword?: string;
  @IsOptional() @IsString() @MaxLength(6) totpCode?: string;
}

/**
 * Löschung der Kontaktdaten — der einzige Weg, personenbezogene Daten wieder
 * loszuwerden.
 *
 * `confirmation` muss den Namen der Organisation wörtlich enthalten. Das ist
 * keine Zierde: Der Vorgang ist unumkehrbar, und ein Fehlgriff in der Liste
 * soll nicht genügen.
 */
export class ContactDataDeleteDto extends EvidenceDto {
  @IsString()
  @IsNotEmpty({ message: 'Bitte den Namen der Organisation zur Bestätigung eingeben.' })
  @MaxLength(200)
  confirmation!: string;
}

/**
 * Die Organisation ganz entfernen.
 *
 * Eigene Klasse, obwohl sie Feld für Feld wie `ContactDataDeleteDto`
 * aussieht: Die beiden Vorgänge haben nichts miteinander zu tun — der eine
 * anonymisiert einen bleibenden Datensatz, der andere entfernt ihn. Ein
 * gemeinsamer Typ hieße, dass eine spätere Änderung am einen stillschweigend
 * am anderen ankommt.
 */
export class CompanyDeleteDto extends EvidenceDto {
  @IsString()
  @IsNotEmpty({ message: 'Bitte den Namen der Organisation zur Bestätigung eingeben.' })
  @MaxLength(200)
  confirmation!: string;
}
