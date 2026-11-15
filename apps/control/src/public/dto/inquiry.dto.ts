import {
  Equals,
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

/** Demo-Zugang anfragen oder Interesse an der Pilotphase melden. */
export const INQUIRY_KINDS = ['demo', 'pilot'] as const;
export type InquiryKind = (typeof INQUIRY_KINDS)[number];

/**
 * Eine Anfrage über das öffentliche Formular der Webseite.
 *
 * Die Feldnamen `art`, `groesse`, `nachricht` und `webseite` sind ABSICHTLICH
 * die aus `apps/api/src/anfrage/dto/anfrage.dto.ts`: Die Webseite schickt
 * genau diese Felder, und der Umzug soll sie nicht umbenennen müssen. Die
 * Unterscheidung Demo/Pilot heißt deshalb `anfrageArt` — `art` war schon
 * vergeben (die Art der Organisation).
 *
 * `webseite` ist der HONEYPOT: ein für Menschen unsichtbares Feld. Ist es
 * ausgefüllt, war es ein Bot.
 */
export class PublicInquiryDto {
  @IsIn(INQUIRY_KINDS as readonly string[], {
    message: 'anfrageArt muss „demo" oder „pilot" sein.',
  })
  inquiryKind!: InquiryKind;

  @IsEmail({}, { message: 'Bitte eine gültige E-Mail-Adresse angeben.' })
  @MaxLength(200)
  email!: string;

  /**
   * Bei einer Pilot-Anfrage Pflicht, bei einer Demo-Anfrage freiwillig — aber
   * WENN mitgeschickt, dann in jedem Fall geprüft.
   *
   * Bewusst über `@ValidateIf` und NICHT über `@IsOptional`: beide Dekoratoren
   * schreiben dieselbe Bedingungsliste, und `class-validator` verlangt, dass
   * ALLE Bedingungen zutreffen. Zusammen hieße das „prüfe nur, wenn Pilot UND
   * ein Wert da ist" — ein fehlender Name bei einer Pilot-Anfrage rutschte
   * dann stillschweigend durch.
   */
  @ValidateIf(
    (dto: PublicInquiryDto) =>
      dto.inquiryKind === 'pilot' || dto.name !== undefined,
  )
  @IsString()
  @IsNotEmpty({ message: 'Ansprechperson ist erforderlich.' })
  @MaxLength(120)
  name?: string;

  @ValidateIf(
    (dto: PublicInquiryDto) =>
      dto.inquiryKind === 'pilot' || dto.company !== undefined,
  )
  @IsString()
  @IsNotEmpty({ message: 'Organisation ist erforderlich.' })
  @MaxLength(200)
  company?: string;

  @IsOptional() @IsString() @MaxLength(60) phone?: string;

  /** Art der Organisation (z. B. „Solawi"), nicht die Art der Anfrage. */
  @IsOptional() @IsString() @MaxLength(120) kind?: string;

  @IsOptional() @IsString() @MaxLength(120) size?: string;

  @IsOptional() @IsString() @MaxLength(2000) message?: string;

  /**
   * Der gewünschte Zahlungsrhythmus — monatlich, halbjährlich oder jährlich.
   *
   * NUR EIN WUNSCH, KEIN VERTRAG. Er wird an der Organisation vermerkt und
   * ist der Ausgangspunkt fürs Gespräch; verbindlich wird er mit dem
   * Vertragsschluss.
   *
   * DIE ZAHLUNGSART STEHT NICHT IM FORMULAR und die IBAN erst recht nicht:
   * Ein SEPA-Mandat braucht eine Unterschrift, und Bankdaten über ein
   * öffentliches Anfrageformular entgegenzunehmen, bevor überhaupt ein
   * Vertrag besteht, wäre in beide Richtungen falsch. Aus dem Rhythmus folgt
   * die Art ohnehin: monatlich heisst Lastschrift.
   */
  @IsOptional()
  @IsIn(['monthly', 'half_yearly', 'yearly'], {
    message:
      'zahlungsweise muss „monatlich", „halbjaehrlich" oder „jaehrlich" sein.',
  })
  paymentInterval?: 'monthly' | 'half_yearly' | 'yearly';

  /**
   * ===================================================================
   * DIE EINWILLIGUNG IN DIE RUNDMAIL — freiwillig, und das ist der Punkt
   * ===================================================================
   *
   * DIE ANFRAGE FUNKTIONIERT OHNE HÄKCHEN. Sie an eine Einwilligung zu
   * koppeln wäre ein Kopplungsverbot-Verstoss (§ 7 UWG, Art. 7 Abs. 4
   * DSGVO) — und praktisch das Gegenteil dessen, was man will: Wer nur
   * fragen möchte, soll fragen können.
   *
   * DAS HÄKCHEN IST NICHT VORAUSGEWÄHLT. Ein vorausgewähltes Häkchen ist
   * keine Einwilligung; das hat der EuGH in „Planet49" ausdrücklich
   * entschieden. Das Formular setzt es deshalb nicht, und der Server
   * behandelt ein fehlendes Feld wie ein „nein".
   *
   * ES ENTSTEHT DARAUS KEINE bestätigte Einwilligung, sondern eine
   * UNBESTÄTIGTE plus eine Bestätigungsmail. Der zweite Klick im Postfach
   * ist der eigentliche Nachweis — dass jemand seine eigene Adresse
   * eingetragen hat, beweist erst er.
   */
  @IsOptional() @IsBoolean() newsletter?: boolean;

  /**
   * DER WORTLAUT, DEM ZUGESTIMMT WURDE — nicht ein Verweis darauf.
   *
   * Er kommt aus dem Formular, weil nur dort steht, was tatsächlich neben
   * dem Häkchen zu lesen war. Ein serverseitig hinterlegter Text wäre eine
   * Behauptung über eine fremde Seite: Ändert die Webseite ihre
   * Formulierung, belegte der Server die alte.
   *
   * PFLICHT, SOBALD DAS HÄKCHEN GESETZT IST. Eine Einwilligung ohne
   * festgehaltenen Wortlaut ist im Streitfall wertlos — dieselbe
   * Begründung wie beim Anlass einer Sperre.
   */
  @ValidateIf((o: { newsletter?: boolean }) => o.newsletter === true)
  @IsString()
  @IsNotEmpty({ message: 'Zu einer Einwilligung gehört ihr Wortlaut.' })
  @MinLength(30, { message: 'Der Einwilligungstext ist zu kurz, um zu tragen.' })
  @MaxLength(2000)
  newsletterWording?: string;

  /**
   * ===================================================================
   * DIE ZUSTIMMUNG ZU DEN AGB – Pflicht bei der Pilot-Anfrage
   * ===================================================================
   *
   * Die Pilotphase ist der Weg in einen Vertrag, und der richtet sich nach
   * den AGB (§ 3 der AGB). Das Häkchen im Formular ist nur Komfort;
   * VERLANGT wird die Zustimmung hier. Bei einer Demo-Anfrage nicht – der
   * Demo-Zugang ist ausdrücklich ohne Vertragsbindung (§ 3 Abs. 3).
   *
   * NACHWEIS WIE BEI DER EINWILLIGUNG: der Satz, wie er neben dem Häkchen
   * stand – er enthält auch die Bestätigung, als Organisation anzufragen,
   * weil die AGB Verbraucher ausschließen –, und der Stand der AGB, auf den
   * er sich bezog. Beides landet im unveränderlichen Audit-Eintrag.
   *
   * `@ValidateIf` statt `@IsOptional` aus demselben Grund wie bei `name`.
   */
  @ValidateIf(
    (dto: PublicInquiryDto) => dto.inquiryKind === 'pilot' || dto.terms !== undefined,
  )
  @Equals(true, { message: 'Für eine Pilot-Anfrage bitte den AGB zustimmen.' })
  terms?: boolean;

  @ValidateIf(
    (dto: PublicInquiryDto) =>
      dto.inquiryKind === 'pilot' || dto.termsWording !== undefined,
  )
  @IsString()
  @IsNotEmpty({ message: 'Zur AGB-Zustimmung gehört ihr Wortlaut.' })
  @MinLength(30, { message: 'Der Wortlaut der AGB-Zustimmung ist zu kurz, um zu tragen.' })
  @MaxLength(500)
  termsWording?: string;

  @ValidateIf(
    (dto: PublicInquiryDto) => dto.inquiryKind === 'pilot' || dto.termsVersion !== undefined,
  )
  @Matches(/^\d{2}\.\d{2}\.\d{4}$/, {
    message: 'agbStand muss ein Datum im Format TT.MM.JJJJ sein.',
  })
  termsVersion?: string;

  /** Honeypot. Ausgefüllt = Bot. */
  @IsOptional() @IsString() @MaxLength(200) website?: string;
}
