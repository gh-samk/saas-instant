import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/** Nachweis für den ZweitfaktorGuard; der Guard liest ihn aus dem rohen Body. */
export class SecondFactorEvidenceDto {
  @IsOptional() @IsString() currentPassword?: string;
  @IsOptional() @IsString() totpCode?: string;
}

const SAFE_PATH = /^[A-Za-z0-9._\-/]*$/;

/** S3-Ziel. `accessKeyId` und `secretAccessKey` sind WRITE-ONLY. */
export class BackupS3Dto {
  @IsString()
  @Matches(/^https?:\/\/[^\s/]+(:\d{1,5})?(\/[^\s]*)?$/, {
    message: 'Der Endpunkt muss mit http:// oder https:// beginnen.',
  })
  @MaxLength(300)
  endpoint!: string;

  @IsString()
  @MaxLength(64)
  region!: string;

  @IsString()
  @Matches(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, {
    message: 'Der Bucket-Name ist ungültig (3 bis 63 Zeichen, Kleinbuchstaben, Ziffern, Punkt, Bindestrich).',
  })
  bucket!: string;

  @IsString()
  @MaxLength(200)
  @Matches(SAFE_PATH, { message: 'Das Präfix enthält unzulässige Zeichen.' })
  prefix!: string;

  @IsBoolean()
  pathStyle!: boolean;

  /** Optional: weggelassen behält der Agent den gespeicherten Wert (nur bei vorhandenem Ziel gleichen Typs; sonst prüft der Dienst). */
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Die Zugangskennung fehlt.' })
  @MaxLength(256)
  accessKeyId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Der geheime Zugangsschlüssel fehlt.' })
  @MaxLength(512)
  secretAccessKey?: string;
}

/** Storage Box (SFTP). `privateKey` und `password` sind WRITE-ONLY. */
export class BackupStorageBoxDto {
  @IsString()
  @Matches(/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/, { message: 'Der Host ist ungültig.' })
  @MaxLength(253)
  host!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  @IsString()
  @Matches(/^[A-Za-z0-9._-]{1,64}$/, { message: 'Der Benutzername ist ungültig.' })
  username!: string;

  @IsString()
  @MaxLength(300)
  @Matches(SAFE_PATH, { message: 'Der Pfad enthält unzulässige Zeichen.' })
  path!: string;

  @IsIn(['key', 'password'])
  authType!: 'key' | 'password';

  @IsOptional() @IsString() @MaxLength(16384) privateKey?: string;

  @IsOptional() @IsString() @MaxLength(512) password?: string;
}

/** PUT /api/settings/backup. */
export class BackupSettingsUpdateDto extends SecondFactorEvidenceDto {
  @IsIn(['s3', 'storagebox'], { message: 'Der Zieltyp muss s3 oder storagebox sein.' })
  type!: 's3' | 'storagebox';

  @IsIn(['daily', 'twice_daily'], { message: 'Der Zeitplan muss daily oder twice_daily sein.' })
  schedule!: 'daily' | 'twice_daily';

  @IsInt()
  @Min(1)
  @Max(3650)
  retentionDays!: number;

  @IsBoolean()
  objectLock!: boolean;

  @ValidateIf((o: BackupSettingsUpdateDto) => o.type === 's3')
  @IsDefined({ message: 'Die S3-Angaben fehlen.' })
  @ValidateNested()
  @Type(() => BackupS3Dto)
  s3?: BackupS3Dto;

  @ValidateIf((o: BackupSettingsUpdateDto) => o.type === 'storagebox')
  @IsDefined({ message: 'Die Storage-Box-Angaben fehlen.' })
  @ValidateNested()
  @Type(() => BackupStorageBoxDto)
  storagebox?: BackupStorageBoxDto;
}
