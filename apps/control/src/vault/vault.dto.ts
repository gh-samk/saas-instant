import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class UnlockDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  secret!: string;
}

export class SetupVaultDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  passphrase!: string;

  /** Nachweis für den ZweitfaktorGuard (wird dort aus dem rohen Body gelesen). */
  @IsOptional() @IsString() currentPassword?: string;
  @IsOptional() @IsString() totpCode?: string;
}

export class AddPassphraseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  passphrase!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;

  @IsOptional() @IsString() currentPassword?: string;
  @IsOptional() @IsString() totpCode?: string;
}

export class ChangePassphraseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  currentPassphrase!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  newPassphrase!: string;

  @IsOptional() @IsString() currentPassword?: string;
  @IsOptional() @IsString() totpCode?: string;
}

export class VaultEvidenceDto {
  @IsOptional() @IsString() currentPassword?: string;
  @IsOptional() @IsString() totpCode?: string;
}
