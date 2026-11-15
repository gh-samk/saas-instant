import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { MailChannel } from '.prisma/control-client';

export const MAIL_CHANNELS = ['transactional', 'marketing'] as const;

/**
 * Eine neue Vorlage.
 *
 * `kanal` ist Pflicht und danach unveränderlich — die Entscheidung
 * „Transaktion oder Werbung" fällt einmal und wird nicht nachträglich
 * umgewidmet (Begründung in `vorlage.service.ts`).
 */
export class TemplateCreateDto {
  @IsString()
  @IsNotEmpty({ message: 'Die Vorlage braucht einen Namen.' })
  @MaxLength(120)
  name!: string;

  @IsIn(MAIL_CHANNELS as readonly string[], {
    message: 'kanal muss „transaktion" oder „werblich" sein.',
  })
  channel!: MailChannel;

  @IsString() @IsNotEmpty() @MaxLength(300) subject!: string;

  /**
   * Der Rumpf als reiner Text — der Weg ohne Redaktionsfeld.
   *
   * Bleibt bestehen und bleibt zulässig: Nicht jeder Aufrufer hat einen
   * Editor, und die Vorlagen aus Etappe 5 sind so entstanden. Wird
   * `inhaltHtml` mitgeschickt, hat es Vorrang und der Server LEITET DEN TEXT
   * SELBST AB (siehe `VorlageService`) — zwei unabhängig gelieferte Fassungen
   * liefen auseinander.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MinLength(20, { message: 'Der Text ist zu kurz für eine Vorlage.' })
  @MaxLength(20_000)
  contentText?: string;

  /**
   * Der Rumpf als formatierter Text aus dem Redaktionsfeld.
   *
   * UNGEPRÜFTE EINGABE. Der Server säubert sie (`saeubere`) und lässt genau
   * fünf Auszeichnungen durch; alles andere fällt still weg. Die Längengrenze
   * ist hier grosszügiger als beim Text, weil Auszeichnungen Platz brauchen —
   * die inhaltliche Grenze prüft der Dienst auf der ABGELEITETEN Textfassung,
   * sonst scheiterte ein kurzer, stark formatierter Text am Markup statt am
   * Wortumfang.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60_000)
  contentHtml?: string;

  /** Erlaubte Platzhalternamen, ohne die geschweiften Klammern. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @Matches(/^[a-z_]{1,40}$/, {
    each: true,
    message: 'Platzhalternamen bestehen aus Kleinbuchstaben und Unterstrich.',
  })
  placeholders?: string[];

  /**
   * ===================================================================
   * DIE STRUKTUR EINER WERBEMAIL — Vorüberschrift, Überschrift, Knopf
   * ===================================================================
   *
   * Sie stehen NICHT im Fliesstext, und das ist keine Bequemlichkeit: Der
   * Säuberer lässt kein `<a>` durch, und er soll es nicht — sonst wäre jede
   * Redaktion ein Weg, eine beliebige Adresse in eine Mail dieses Hauses zu
   * setzen. Der Knopf ist der eine Ort, an dem eine Adresse hineinkommt, und
   * genau deshalb wird sie streng geprüft.
   *
   * ALLE VIER OPTIONAL. Eine Vorlage ohne sie rahmt sich wie bisher.
   */
  @IsOptional() @IsString() @MaxLength(80) eyebrow?: string;

  @IsOptional() @IsString() @MaxLength(200) heading?: string;

  @IsOptional() @IsString() @MaxLength(60) buttonText?: string;

  /**
   * NUR http UND https. Ein `javascript:`- oder `data:`-Ziel hat in einer
   * Mail nichts verloren, und ein Schema, das ein Mailprogramm anders
   * auflöst als der Browser, ist genau die Art von Überraschung, die man in
   * einer Nachricht an Fremde nicht haben will.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^https?:\/\/\S+$/i, {
    message:
      'Das Ziel des Knopfes muss mit http:// oder https:// beginnen.',
  })
  buttonTarget?: string;
}

/** Redaktion an einer bestehenden Vorlage. Kanal und Name bleiben, wie sie sind. */
export class TemplateChangeDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(300) subject?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MinLength(20)
  @MaxLength(20_000)
  contentText?: string;

  /** Der formatierte Rumpf. Wird gesäubert; `inhaltText` folgt daraus. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60_000)
  contentHtml?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @Matches(/^[a-z_]{1,40}$/, { each: true })
  placeholders?: string[];

  /**
   * ===================================================================
   * DIE STRUKTUR EINER WERBEMAIL — Vorüberschrift, Überschrift, Knopf
   * ===================================================================
   *
   * Sie stehen NICHT im Fliesstext, und das ist keine Bequemlichkeit: Der
   * Säuberer lässt kein `<a>` durch, und er soll es nicht — sonst wäre jede
   * Redaktion ein Weg, eine beliebige Adresse in eine Mail dieses Hauses zu
   * setzen. Der Knopf ist der eine Ort, an dem eine Adresse hineinkommt, und
   * genau deshalb wird sie streng geprüft.
   *
   * ALLE VIER OPTIONAL. Eine Vorlage ohne sie rahmt sich wie bisher.
   */
  @IsOptional() @IsString() @MaxLength(80) eyebrow?: string;

  @IsOptional() @IsString() @MaxLength(200) heading?: string;

  @IsOptional() @IsString() @MaxLength(60) buttonText?: string;

  /**
   * NUR http UND https. Ein `javascript:`- oder `data:`-Ziel hat in einer
   * Mail nichts verloren, und ein Schema, das ein Mailprogramm anders
   * auflöst als der Browser, ist genau die Art von Überraschung, die man in
   * einer Nachricht an Fremde nicht haben will.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^https?:\/\/\S+$/i, {
    message:
      'Das Ziel des Knopfes muss mit http:// oder https:// beginnen.',
  })
  buttonTarget?: string;

  @IsOptional() @IsBoolean() active?: boolean;
}

/**
 * Rundmail einstellen oder testen.
 *
 * ES GIBT KEIN EMPFÄNGERFELD. Wer die Mail bekommt, entscheidet
 * ausschliesslich die Einwilligungstabelle — nicht der Aufrufer. Ein
 * Adressfeld an dieser Stelle wäre der Weg, R3 „durch Fehlbedienung" zu
 * umgehen.
 *
 * Die beiden Nachweisfelder liest der `ZweitfaktorGuard` aus dem rohen Body.
 * Sie stehen hier, weil die globale `ValidationPipe` mit
 * `forbidNonWhitelisted` unbekannte Felder sonst ablehnte.
 */
export class BroadcastSendDto {
  @IsOptional() @IsString() currentPassword?: string;
  @IsOptional() @IsString() totpCode?: string;
}
