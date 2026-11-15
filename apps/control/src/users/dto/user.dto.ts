import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Ein weiteres Konto eintragen.
 *
 * ES GIBT KEIN ROLLENFELD. Alle Konten können dasselbe — das ist die
 * Entscheidung des Auftraggebers, und sie steht auch in der Oberfläche.
 * Ein Feld, das nur einen Wert annehmen kann, wäre eine Wahl, die es nicht
 * gibt.
 */
export class UserDto {
  @IsString()
  @IsNotEmpty({ message: 'Zu einem Konto gehört ein Name.' })
  @MaxLength(120)
  name!: string;

  /**
   * Zugleich der Anmeldename.
   *
   * Sich einen zweiten Namen ausdenken zu lassen, bevor jemand das Konto
   * überhaupt in der Hand hatte, wäre eine Entscheidung an der falschen
   * Stelle. Ändern lässt er sich später.
   */
  @IsEmail({}, { message: 'Bitte eine gültige E-Mail-Adresse angeben.' })
  @MaxLength(254)
  email!: string;

  /** Nachweis für den ZweitfaktorGuard. Der Guard liest ihn aus dem Body. */
  @IsOptional() @IsString() currentPassword?: string;
  @IsOptional() @IsString() totpCode?: string;
}

/**
 * Zugang entziehen oder wieder erteilen.
 *
 * EIN FELD `aktiv` STATT ZWEIER ROUTEN. Ein `DELETE` auf ein Konto wäre der
 * falsche Ausdruck: Gelöscht wird hier nichts, und der Weg zurück soll
 * genauso aussehen wie der Weg hin.
 */
export class AccessDto {
  @IsOptional() @IsString() currentPassword?: string;
  @IsOptional() @IsString() totpCode?: string;

  // OHNE Decorator weist die globale ValidationPipe (whitelist +
  // forbidNonWhitelisted) das Feld als unbekannt ab. Bis zur Prüfung vom
  // 13.09.2026 endete deshalb JEDER Aufruf mit 400, und kein Konto liess sich
  // über die Oberfläche sperren oder wieder freigeben. `benutzer.dto.spec.ts`
  // prüft die Route mit genau der Pipe-Konfiguration aus `main.ts`.
  @IsBoolean() active!: boolean;
}

/**
 * Adresse eines Kontos OHNE Zugang berichtigen ([Review B1]).
 *
 * Der Einladungslink geht nicht per Mail hinaus, sondern an die Administration
 * — wer damit ein Passwort setzt, hat die Adresse also NICHT bewiesen. Ist sie
 * vertippt, ginge der Anmeldecode an ein fremdes Postfach und die Eingeladene
 * bliebe vor Schritt 2 stecken. Dieser Weg berichtigt sie, solange das Konto
 * noch keinen Zugang hat. Danach ändert die Person ihre Adresse selbst.
 */
export class AddressDto {
  @IsEmail({}, { message: 'Bitte eine gültige E-Mail-Adresse angeben.' })
  @MaxLength(254)
  email!: string;

  // Nachweis für den ZweitfaktorGuard, wie in ZugangDto.
  @IsOptional() @IsString() @MaxLength(1024) currentPassword?: string;
  @IsOptional() @IsString() @MaxLength(6) totpCode?: string;
}
