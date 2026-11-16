import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { LEGAL_FORMS } from '@saas-instant/shared';

const SHORT = 200;
const NAMES = 20;

const text = (message: string) => ({ message, each: false });

/** Persönlich haftende Gesellschafterin (GmbH & Co. KG). */
export class GeneralPartnerDto {
  @IsString() @MaxLength(SHORT, text('Zu lang.')) name!: string;
  @IsString() @MaxLength(SHORT) seat!: string;
  @IsString() @MaxLength(SHORT) registerCourt!: string;
  @IsString() @MaxLength(SHORT) registerNumber!: string;
  @IsArray() @ArrayMaxSize(NAMES) @IsString({ each: true }) @MaxLength(SHORT, { each: true })
  managingDirectors!: string[];
}

/** Das gesamte Firmenprofil, wie die Oberfläche es schickt (vollständig, nicht teilweise). */
export class IssuerProfileDto {
  @IsIn(Object.keys(LEGAL_FORMS), { message: 'Unbekannte Rechtsform.' })
  legalForm!: string;
  @IsBoolean() registered!: boolean;
  @IsString() @MaxLength(SHORT) name!: string;
  @IsString() @MaxLength(SHORT) ownerName!: string;
  @IsArray() @ArrayMaxSize(NAMES) @IsString({ each: true }) @MaxLength(SHORT, { each: true })
  partners!: string[];
  @IsString() @MaxLength(SHORT) street!: string;
  @IsString() @MaxLength(20) postalCode!: string;
  @IsString() @MaxLength(SHORT) city!: string;
  @IsString() @MaxLength(SHORT) country!: string;
  @IsString() @MaxLength(SHORT) seat!: string;
  @IsString() @MaxLength(SHORT) registerCourt!: string;
  @IsString() @MaxLength(SHORT) registerNumber!: string;
  @IsArray() @ArrayMaxSize(NAMES) @IsString({ each: true }) @MaxLength(SHORT, { each: true })
  managingPersons!: string[];
  @ValidateNested() @Type(() => GeneralPartnerDto) generalPartner!: GeneralPartnerDto;
  @IsString() @MaxLength(40) vatId!: string;
  @IsString() @MaxLength(40) taxNumber!: string;
  @IsString() @MaxLength(60) phone!: string;
  @IsString() @MaxLength(SHORT) email!: string;
  @IsString() @MaxLength(SHORT) web!: string;
  @IsString() @MaxLength(SHORT) bankName!: string;
  @IsString() @MaxLength(SHORT) accountHolder!: string;
  @IsString() @MaxLength(50) iban!: string;
  @IsString() @MaxLength(20) bic!: string;
  @IsString() @MaxLength(40) creditorId!: string;
}

export class IssuerUpdateDto {
  @ValidateNested() @Type(() => IssuerProfileDto) profile!: IssuerProfileDto;

  /** `#rrggbb` oder `null` (Vorgabe des Renderers). */
  @IsOptional() @IsString() @MaxLength(7) accentColor?: string | null;

  /**
   * Nachweis für den `SecondFactorGuard`: Er liest ihn aus dem Body, und die
   * globale `ValidationPipe` (`forbidNonWhitelisted`) lehnt jedes Feld ab, das
   * in keinem DTO steht. Ohne diese Felder scheiterte jedes Speichern mit
   * einer Sitzung über zehn Minuten mit 400, statt den Nachweis anzunehmen.
   */
  @IsOptional() @IsString() currentPassword?: string;

  @IsOptional() @IsString() totpCode?: string;
}
