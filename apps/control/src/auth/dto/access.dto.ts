import {
  IsEmail,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Registrierung eines Passkeys abschließen. */
export class PasskeyRegistrationDto {
  @IsObject({ message: 'Die Passkey-Registrierung fehlt.' })
  response!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}

/** Registrierung über einen Notfall-Registrierlink starten. */
export class EmergencyStartDto {
  @IsString()
  @IsNotEmpty({ message: 'Der Registrierlink ist unvollständig.' })
  @MaxLength(512)
  token!: string;
}

/** Registrierung über einen Notfall-Registrierlink abschließen. */
export class EmergencyCompleteDto extends EmergencyStartDto {
  @IsObject({ message: 'Die Passkey-Registrierung fehlt.' })
  response!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}

/** Neues Passwort über einen Notfall-Link setzen. */
export class EmergencyPasswordDto extends EmergencyStartDto {
  @IsString()
  @MinLength(12, {
    message: 'Das neue Passwort muss mindestens 12 Zeichen haben.',
  })
  @MaxLength(1024)
  password!: string;
}

/**
 * Passwort aus einer bestehenden Sitzung setzen oder ändern.
 *
 * `aktuellesPasswort` ist optional, weil bei der Ersteinrichtung noch keines
 * existiert. Ob es verlangt wird, entscheidet der Server anhand des Kontos —
 * nicht der Client.
 */
export class PasswordSetDto {
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  currentPassword?: string;

  @IsString()
  @MinLength(12, {
    message: 'Das neue Passwort muss mindestens 12 Zeichen haben.',
  })
  @MaxLength(1024)
  newPassword!: string;
}

/**
 * Nachweis eines zweiten Faktors, bevor ein neuer Passkey angelegt wird.
 *
 * Genau eines von beidem genügt. Ohne diesen Nachweis könnte, wer ein
 * Sitzungs-Cookie erbeutet, sich einen eigenen einstufigen Dauerzugang anlegen.
 */
export class SecondFactorEvidenceDto {
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  currentPassword?: string;

  @IsOptional()
  @IsString()
  @Length(6, 6, { message: 'Der Bestätigungscode besteht aus sechs Ziffern.' })
  totpCode?: string;
}

/** Bestätigung der TOTP-Einrichtung. */
export class TotpConfirmDto {
  @IsString()
  @Length(6, 6, { message: 'Der Bestätigungscode besteht aus sechs Ziffern.' })
  code!: string;
}

/**
 * Faktor „Code per E-Mail" einrichten oder seine Zieladresse ändern.
 *
 * `email` darf fehlen — dann geht der Code an die bereits hinterlegte Adresse,
 * ersatzweise an die Konto-E-Mail. Übernommen wird die Adresse erst mit
 * `EmailCodeBestaetigenDto`.
 *
 * Erbt den Nachweis des zweiten Faktors (`aktuellesPasswort` ODER `totpCode`),
 * genau wie die Passkey-Registrierung. Bei einer Sitzung, die jünger als zehn
 * Minuten ist, entfällt er — das deckt die Ersteinrichtung ab.
 */
export class EmailCodeSetupDto extends SecondFactorEvidenceDto {
  @IsOptional()
  @IsEmail({}, { message: 'Bitte eine gültige E-Mail-Adresse eingeben.' })
  @MaxLength(254)
  email?: string;
}

/** Bestätigung des achtstelligen Einrichtungscodes. */
export class EmailCodeConfirmDto {
  @IsString()
  @Length(8, 8, { message: 'Der Code besteht aus acht Ziffern.' })
  @Matches(/^\d{8}$/, { message: 'Der Code besteht aus acht Ziffern.' })
  code!: string;
}

/**
 * Entfernen eines zweiten Faktors — verlangt denselben Nachweis wie das
 * Hinzufügen (`aktuellesPasswort` ODER `totpCode`), mit derselben Ausnahme für
 * eine frische Sitzung. Der Body ist bei DELETE optional; fehlt er ganz, greift
 * die Frische-Regel bzw. es folgt 401.
 */
export class FactorRemoveDto extends SecondFactorEvidenceDto {}
