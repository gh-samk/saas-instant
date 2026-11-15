import { Type } from 'class-transformer';
import {
  PAYMENT_STATES,
  type PaymentState,
} from '../invoice.response';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { TAX_CATEGORIES } from '../invoice.amount';
import { IsCalendarDate } from '../../common/validators/is-calendar-date';

/**
 * DTOs des Rechnungsmoduls.
 *
 * ALLE GELDBETRÄGE ALS GANZE CENT (`…Cent`). Der Erkundungsschritt nennt den
 * Grund, und er gilt schon an der Schnittstelle: Käme der Betrag als
 * Gleitkommazahl herein, wäre der erste Rundungsfehler bereits passiert, bevor
 * irgendetwas gerechnet wird. `19.99` ist in JSON keine exakte Zahl, `1999`
 * schon.
 */

/** Ein Posten im Entwurf. */
export class InvoiceLineDto {
  @IsString()
  @IsNotEmpty({ message: 'Die Bezeichnung des Postens fehlt.' })
  @MaxLength(200, { message: 'Die Bezeichnung darf höchstens 200 Zeichen haben.' })
  label!: string;

  @IsOptional()
  @IsString()
  @MaxLength(600, { message: 'Die Beschreibung darf höchstens 600 Zeichen haben.' })
  description?: string;

  /**
   * Menge mit bis zu drei Nachkommastellen (`Decimal(10,3)`).
   *
   * Darf negativ sein — eine Stornorechnung entsteht aus negativen Mengen.
   * `0` ist ausgeschlossen: ein Posten ohne Menge ist ein Posten ohne Aussage.
   */
  @IsNumber(
    { maxDecimalPlaces: 3 },
    { message: 'Die Menge darf höchstens drei Nachkommastellen haben.' },
  )
  @Min(-1_000_000)
  @Max(1_000_000)
  quantity!: number;

  /** Leistungszeitraum JE POSTEN, beide oder keiner. */
  @IsOptional() @IsCalendarDate() periodFrom?: string;
  @IsOptional() @IsCalendarDate() periodUntil?: string;

  @IsInt({ message: 'Der Einzelpreis muss in ganzen Cent angegeben werden.' })
  // Rund zehn Millionen Euro. Alles darüber ist ein Tippfehler oder eine
  // falsche Einheit, keine Rechnung — und `Decimal(10,2)` liefe über.
  @Min(-99_999_999)
  @Max(99_999_999)
  unitPriceNetCent!: number;

  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'Der Steuersatz darf höchstens zwei Nachkommastellen haben.' },
  )
  @Min(0)
  @Max(100)
  taxRate!: number;

  /** UN/ECE Rec. 20, z. B. `C62` (Pauschale), `MON` (Monat), `ANN` (Jahr). */
  @IsOptional()
  @IsString()
  @MaxLength(3)
  unit?: string;

  /**
   * Preisstufe, aus der der Posten stammt (Preisvorschlag). Nur im ENTWURF
   * schreibbar; mit dem Festschreiben friert der Bezug ein. Das Etikett setzt
   * der Dienst aus der Preisliste, nicht der Client.
   */
  @IsOptional() @IsString() @MaxLength(60) priceTierKey?: string;
  @IsOptional() @IsString() @MaxLength(120) priceTierLabel?: string;

  /**
   * Steuerkategorie nach UNTDID 5305. Vorgabe `S` (Regelsatz). Alle anderen
   * verlangen den Satz 0; E, AE, K, G und O zusätzlich einen Befreiungsgrund.
   */
  @IsOptional()
  @IsIn(TAX_CATEGORIES as readonly string[], {
    message: 'Unbekannte Steuerkategorie (erlaubt: S, Z, E, AE, K, G, O).',
  })
  taxCategory?: string;

  /** Befreiungsgrund (BT-120), z. B. „§ 4 Nr. 21 UStG". */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  taxExemptionReason?: string;
}

/** Ein neuer Rechnungsentwurf. */
export class InvoiceDraftDto {
  @IsCalendarDate()
  invoiceDate!: string;

  @IsCalendarDate()
  servicePeriodFrom!: string;

  @IsCalendarDate()
  servicePeriodUntil!: string;

  /**
   * Zahlungsziel. Optional: fehlt es, rechnet der Dienst
   * `rechnungsdatum + paymentDueDays` aus der Preistafel.
   */
  @IsOptional()
  @IsCalendarDate()
  dueDate?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Eine Rechnung braucht mindestens einen Posten.' })
  // Eine Rechnung mit mehr als fünfzig Posten ist keine Abo-Rechnung mehr.
  // Die Grenze schützt zugleich das Seitenlayout des PDF.
  @ArrayMaxSize(50, { message: 'Höchstens 50 Posten je Rechnung.' })
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineDto)
  lines!: InvoiceLineDto[];

  /** Einleitungssatz auf dem Beleg. */
  @IsOptional() @IsString() @MaxLength(2000) introduction?: string;

  /** Zahlungshinweis auf dem Beleg. */
  @IsOptional() @IsString() @MaxLength(500) paymentNote?: string;

  /**
   * Der Zettel am Vorgang. Steht NICHT auf dem Beleg und geht in keine Mail —
   * deshalb auch nicht im Schnappschuss.
   */
  @IsOptional() @IsString() @MaxLength(2000) internalNote?: string;
}

/**
 * Änderung eines Entwurfs.
 *
 * ES GIBT BEWUSST KEIN GEGENSTÜCK FÜR FESTGESCHRIEBENE RECHNUNGEN (R2). Wer
 * eine festgeschriebene Kennung hierher schickt, bekommt einen Konflikt —
 * geprüft im Dienst, nicht nur in der Route.
 */
export class InvoiceDraftUpdateDto extends InvoiceDraftDto {}

/** Das Festschreiben. Trägt keine Daten, nur die ausdrückliche Bestätigung. */
export class FinalizeDto {
  /**
   * Die Betreiberin bestätigt, dass die Rechnung so hinausgeht.
   *
   * Der Wert muss wörtlich `festschreiben` sein. Das ist keine Förmlichkeit:
   * Nach diesem Aufruf gibt es keinen Weg zurück außer einer Stornorechnung,
   * und ein versehentliches Absenden eines Formulars soll dafür nicht
   * genügen — dieselbe Bauweise wie bei der Kontaktdatenlöschung.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  confirmation!: string;

  /** Nachweis für den ZweitfaktorGuard ([K3]). Der Guard liest ihn aus dem Body. */
  @IsOptional() @IsString() currentPassword?: string;

  @IsOptional() @IsString() totpCode?: string;
}

/** Die Stornierung. */
export class CancellationDto {
  @IsString()
  @IsNotEmpty({ message: 'Zu einem Storno gehört ein Grund.' })
  @MaxLength(300, { message: 'Der Grund darf höchstens 300 Zeichen haben.' })
  reason!: string;

  /** Nachweis für den ZweitfaktorGuard ([K3]). */
  @IsOptional() @IsString() currentPassword?: string;

  @IsOptional() @IsString() totpCode?: string;
}

/**
 * Versenden und Erinnern haben keine eigenen Angaben — dieses DTO trägt
 * ausschliesslich den Nachweis des zweiten Faktors.
 *
 * Es muss trotzdem existieren: Die globale `ValidationPipe` lehnt mit
 * `forbidNonWhitelisted` jedes Feld ab, das in keinem DTO steht. Ohne diese
 * Klasse käme der Nachweis nie beim Guard an.
 */
export class SendEvidenceDto {
  @IsOptional() @IsString() currentPassword?: string;

  @IsOptional() @IsString() totpCode?: string;
}

/**
 * Eine Zahlung, VON HAND vermerkt.
 *
 * Es gibt keinen Kontoabgleich und keine Bankschnittstelle — ausdrücklich
 * nicht Teil dieses Systems. Diese Angaben tippt die Betreiberin ab, nachdem
 * sie auf den Kontoauszug gesehen hat.
 */
export class PaymentDto {
  @IsCalendarDate()
  paymentDate!: string;

  @IsInt({ message: 'Der gezahlte Betrag muss in ganzen Cent angegeben werden.' })
  @Min(-99_999_999)
  @Max(99_999_999)
  paidAmountCent!: number;

  /** Nachweis für den ZweitfaktorGuard. Wird vom Guard aus dem Body gelesen. */
  @IsOptional()
  @IsString()
  currentPassword?: string;

  @IsOptional()
  @IsString()
  totpCode?: string;
}

/**
 * Der Übertragungsvermerk an die Buchhaltung.
 *
 * AUSDRÜCKLICH OHNE SCHNITTSTELLE: keine lexoffice-API, keine sevDesk-API. Der
 * Auftraggeber überträgt die Belege von Hand und setzt hier den Vermerk.
 */
export class TransferDto {
  @IsString()
  @MaxLength(80)
  transferStatus!: string;
}

/** Abfrage des Preisvorschlags. */
export class PriceSuggestionQueryDto {
  @IsOptional()
  @IsCalendarDate()
  cutoffDate?: string;
}

/** Filter der Rechnungsliste. */
export class InvoiceListDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  companyId?: string;

  /**
   * Der ABGELEITETE Zahlungsstand, nicht die Statusspalte.
   *
   * „Offen" und „ueberfaellig" unterscheiden sich nur am Faelligkeitsdatum
   * gegen heute; beides steht nirgends als Spalte. Die Filterchips des
   * Entwurfs sprechen von diesen Werten, also nimmt der Endpunkt sie auch
   * entgegen.
   */
  @IsOptional()
  @IsIn([...PAYMENT_STATES])
  state?: PaymentState;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  perPage?: number;
}

/** Bezugsjahr der Kennzahlen. Ohne Angabe das laufende. */
export class InvoiceMetricsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2200)
  year?: number;
}

/**
 * Zeitraum des GoBD-Exports (Pruefer-Zugriff), nach Rechnungsdatum, beide
 * Grenzen einschliesslich. Als GET-Query und als POST-Body benutzt; im Body
 * traegt er zusaetzlich den Nachweis fuer den `SecondFactorGuard`.
 */
export class GobdExportDto {
  @IsCalendarDate()
  from!: string;

  @IsCalendarDate()
  to!: string;

  @IsOptional() @IsString() currentPassword?: string;

  @IsOptional() @IsString() totpCode?: string;
}
