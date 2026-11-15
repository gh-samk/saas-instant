import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** Obergrenze je Betrag in Cent (rund zehn Millionen Euro, wie bei Postenpreisen). */
const MAX_CENT = 99_999_999;

/** Eine Preisstufe, wie die Oberfläche sie schickt. */
export class PriceTierDto {
  /** Stabiler Schlüssel; steht in `Company.priceTier` und auf Rechnungsposten. */
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/, {
    message:
      'Der Schlüssel darf nur Buchstaben, Ziffern, Punkt, Binde- und Unterstrich enthalten (höchstens 60 Zeichen).',
  })
  key!: string;

  @IsString()
  @MinLength(1, { message: 'Die Bezeichnung der Stufe fehlt.' })
  @MaxLength(120, { message: 'Die Bezeichnung darf höchstens 120 Zeichen haben.' })
  label!: string;

  /** Obere Schwelle einschließlich; `null` = nach oben offen. */
  @IsOptional()
  @IsInt({ message: 'Die Personenschwelle muss eine ganze Zahl sein.' })
  @Min(1)
  @Max(1_000_000)
  maxPersons?: number | null;

  @IsInt({ message: 'Beträge werden in ganzen Cent angegeben.' })
  @Min(0)
  @Max(MAX_CENT)
  monthlyCent!: number;

  @IsInt({ message: 'Beträge werden in ganzen Cent angegeben.' })
  @Min(0)
  @Max(MAX_CENT)
  halfYearlyCent!: number;

  @IsInt({ message: 'Beträge werden in ganzen Cent angegeben.' })
  @Min(0)
  @Max(MAX_CENT)
  yearlyCent!: number;

  @IsInt({ message: 'Beträge werden in ganzen Cent angegeben.' })
  @Min(0)
  @Max(MAX_CENT)
  setupCent!: number;

  /** Archivierte Stufen bleiben erhalten (Altwerte), gelten aber nicht mehr. */
  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}

/**
 * Die gesamte Preisliste.
 *
 * VOLLSTÄNDIG, NICHT TEILWEISE: Die Reihenfolge der Stufen im Array ist die
 * Reihenfolge der Schwellen. Stufen, die im Array fehlen, werden ARCHIVIERT
 * (nie gelöscht) — eine Rechnung oder Organisation darf ihren Schlüssel nicht
 * verlieren.
 */
export class PricesUpdateDto {
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'Der Steuersatz darf höchstens zwei Nachkommastellen haben.' },
  )
  @Min(0)
  @Max(100)
  taxRatePercent!: number;

  @IsInt()
  @Min(0)
  @Max(365)
  paymentTermDays!: number;

  @IsInt()
  @Min(1)
  @Max(365)
  averageDays!: number;

  @IsOptional()
  @IsIn(['EUR'], { message: 'Derzeit wird nur in Euro abgerechnet.' })
  currency?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Es muss mindestens eine Preisstufe geben.' })
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PriceTierDto)
  tiers!: PriceTierDto[];

  /** Nachweis für den ZweitfaktorGuard; der Guard liest ihn aus dem Body. */
  @IsOptional() @IsString() currentPassword?: string;

  @IsOptional() @IsString() totpCode?: string;
}
