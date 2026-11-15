import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Eintragung über das EIGENE Anmeldeformular des Newsletters.
 *
 * ===========================================================================
 * WARUM DAS EIN EIGENES FORMULAR IST UND KEIN HÄKCHEN IM DEMO-FORMULAR
 * ===========================================================================
 *
 * „Ein Formular, das nach der Demo fragt und nebenbei den Newsletter
 * einsammelt, ist der Fall, der abgemahnt wird."
 *
 * Deshalb gibt es diesen Endpunkt getrennt von `POST /api/oeffentlich/anfrage`
 * und deshalb nimmt die Anfrage-Route keinerlei Newsletter-Feld entgegen.
 * Beides zusammenzulegen wäre ein Handgriff und genau der falsche: Wer eine
 * Demo will, hat damit nicht in Werbung eingewilligt, und ein vorbelegtes oder
 * mitgebuchtes Häkchen macht daraus keine Einwilligung, sondern einen
 * Streitfall.
 *
 * `formulartextImWortlaut` IST PFLICHT UND DER EIGENTLICHE WERT. Gespeichert
 * wird nicht „hat zugestimmt", sondern WOZU zugestimmt wurde — der Satz, der
 * am Häkchen stand, Zeichen für Zeichen. Er kommt aus dem Formular und nicht
 * aus einer Vorlage im Server: Eine Vorlage kann sich ändern, der Satz von
 * damals nicht. Ohne ihn ist das Häkchen im Streitfall wertlos.
 */
export class ConsentSubscribeDto {
  @IsEmail({}, { message: 'Bitte eine gültige E-Mail-Adresse angeben.' })
  @MaxLength(254)
  email!: string;

  /**
   * Der Wortlaut, dem zugestimmt wurde. Mindestlänge mit Absicht: Ein „ja"
   * oder ein leerer String wäre kein Nachweis, sondern eine Behauptung.
   */
  @IsString()
  @IsNotEmpty({ message: 'Der Formulartext im Wortlaut ist erforderlich.' })
  @MinLength(30, {
    message:
      'Der Formulartext im Wortlaut ist zu kurz, um ein Nachweis zu sein.',
  })
  @MaxLength(4000)
  formText!: string;

  /** Wo das Formular steht, z. B. „webseite-newsletter". */
  @IsOptional() @IsString() @MaxLength(120) origin?: string;

  /** Bekannte Organisation, falls die Eintragung aus dem CRM stammt. */
  @IsOptional() @IsUUID('4') companyId?: string;

  /**
   * Honeypot. Ausgefüllt = Bot — derselbe Feldname wie im Anfrageformular,
   * damit die Webseite ihr Muster nicht ändern muss.
   */
  @IsOptional() @IsString() @MaxLength(200) website?: string;
}

/** Die drei Sperrgründe, die von Hand gesetzt werden dürfen. */
export const BLOCK_REASONS = [
  /** Widerspruch der Person, uns auf anderem Weg zugegangen (Art. 21 DSGVO). */
  'unsubscribed',
  /** Adresse nimmt nichts mehr an. */
  'hard_bounced',
  /** Beschwerde über den Postfachanbieter. Endgültig. */
  'spam_reported',
] as const;

export type BlockReason = (typeof BLOCK_REASONS)[number];

/**
 * Eine Adresse VON HAND sperren ([W4]).
 *
 * ES GIBT KEIN GEGENSTÜCK: Kein Feld, kein Wert und keine zweite Route hebt
 * eine Sperre wieder auf. Die Aufzählung enthält deshalb ausschliesslich
 * Sperrzustände — `bestaetigt` und `unbestaetigt` stehen bewusst nicht darin.
 */
export class AddressBlockDto {
  @IsEmail({}, { message: 'Bitte eine gültige E-Mail-Adresse angeben.' })
  @MaxLength(254)
  email!: string;

  @IsIn(BLOCK_REASONS as readonly string[], {
    message:
      'grund muss „abgemeldet", „hart_abgewiesen" oder „spam_gemeldet" sein.',
  })
  reason!: BlockReason;

  /**
   * WOHER der Widerspruch kam — „telefonisch am 30.08.", „Antwortmail",
   * „Brief". Pflicht und mit Mindestlänge: Eine Sperre ohne festgehaltenen
   * Anlass lässt sich später nicht mehr belegen, und genau darauf käme es an,
   * wenn jemand fragt, warum er keine Post mehr bekommt.
   */
  @IsString()
  @IsNotEmpty({ message: 'Zu einer Sperre gehört ein Anlass.' })
  @MinLength(10, { message: 'Der Anlass ist zu kurz, um später zu tragen.' })
  @MaxLength(500)
  justification!: string;

  /** Nachweis für den ZweitfaktorGuard. Der Guard liest ihn aus dem Body. */
  @IsOptional() @IsString() currentPassword?: string;

  @IsOptional() @IsString() totpCode?: string;
}
