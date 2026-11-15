import {
  IsBoolean,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

/** Schritt 1: Kennung (Nutzername ODER E-Mail) plus Passwort. */
export class LoginDto {
  @IsString()
  @IsNotEmpty({ message: 'Bitte Benutzername oder E-Mail-Adresse eingeben.' })
  @MaxLength(254)
  identifier!: string;

  @IsString()
  @IsNotEmpty({ message: 'Bitte das Passwort eingeben.' })
  @MaxLength(1024)
  password!: string;
}

/** Schritt 2a: Code aus der Authenticator-App. */
export class SecondFactorTotpDto {
  @IsString()
  @Length(6, 6, { message: 'Der Bestätigungscode besteht aus sechs Ziffern.' })
  code!: string;

  /** Merkt diesen Browser für 30 Tage, überspringt dann nur den zweiten Faktor. */
  @IsOptional()
  @IsBoolean()
  deviceRemember?: boolean;
}

/**
 * Anforderung eines achtstelligen Anmeldecodes per E-Mail.
 *
 * Die Route ist unauthentifiziert und antwortet IMMER gleich — ob es die
 * Kennung gibt, darf sie nicht verraten (siehe `fordereAnmeldecodeAn`).
 */
export class LoginCodeRequestDto {
  @IsString()
  @IsNotEmpty({ message: 'Bitte Benutzername oder E-Mail-Adresse eingeben.' })
  @MaxLength(254)
  identifier!: string;
}

/** Schritt 2b: achtstelliger Code aus der E-Mail. */
export class SecondFactorEmailCodeDto {
  @IsString()
  @Length(8, 8, { message: 'Der Anmeldecode besteht aus acht Ziffern.' })
  @Matches(/^\d{8}$/, {
    message: 'Der Anmeldecode besteht aus acht Ziffern.',
  })
  code!: string;

  /** Merkt diesen Browser für 30 Tage, überspringt dann nur den zweiten Faktor. */
  @IsOptional()
  @IsBoolean()
  deviceRemember?: boolean;
}

/** Schritt 2c: Wiederherstellungscode statt TOTP oder E-Mail-Code. */
export class SecondFactorRecoveryDto {
  @IsString()
  @IsNotEmpty({ message: 'Bitte einen Wiederherstellungscode eingeben.' })
  @MaxLength(64)
  code!: string;
}

/**
 * Start einer Passkey-Anmeldung. Der Body darf leer sein.
 *
 * `kennung` wird ENTGEGENGENOMMEN, ABER NICHT AUSGEWERTET: Die Route ist
 * unauthentifiziert, und eine kennungsabhängige Antwort verriete, welche Konten
 * existieren. Das Feld bleibt nur erlaubt, damit ein Client, der es noch
 * mitschickt, keine 400 bekommt. Neue Clients lassen es weg.
 */
export class PasskeyStartDto {
  @IsOptional()
  @IsString()
  @MaxLength(254)
  identifier?: string;
}

/** Abschluss einer Passkey-Anmeldung. */
export class PasskeyCompleteDto {
  @IsObject({ message: 'Die Passkey-Antwort fehlt.' })
  response!: Record<string, unknown>;
}
