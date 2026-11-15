import { Injectable } from '@nestjs/common';
import type { MailChannel } from '.prisma/control-client';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import type { InquirySource } from '../common/inquiry-source';
import {
  htmlFromText,
  sanitize,
  textFrom,
  transactionalLayout,
} from '../mail/layout';
import { PrismaService } from '../prisma/prisma.service';
import {
  replace,
  replaceInHtml,
  DEFAULT_PLACEHOLDER,
  unknownPlaceholder,
} from './placeholder';
import { MarketingMailService } from './marketing-mail.service';
import {
  UnknownPlaceholderError,
  TemplateWrongChannelError,
  TemplateContentError,
  TemplateNotActiveError,
  TemplateNotFoundError,
} from './broadcast.errors';

/**
 * Wie lang der Rumpf einer Vorlage sein darf — gemessen an der TEXTFASSUNG.
 *
 * Dieselben Werte, die die DTOs schon für den reinen Text setzen. Sie stehen
 * hier ein zweites Mal, weil sie beim HTML-Weg auf etwas anderes angewendet
 * werden müssen als auf die Eingabe: auf das, was nach dem Säubern und
 * Ableiten übrig ist.
 */
export const CONTENT_MIN_CHARACTERS = 20;
export const CONTENT_MAX_CHARACTERS = 20_000;

/** Wer handelt. */
export interface Actor {
  userId: string | null;
  name: string;
}

export interface TemplateResponse {
  id: string;
  name: string;
  channel: MailChannel;
  subject: string;
  contentText: string;
  /**
   * Der formatierte Rumpf, so wie er nach der Säuberung gespeichert ist.
   *
   * `null` bei Vorlagen aus der Zeit vor dem Redaktionsfeld — dann gilt
   * `inhaltText`. Die Oberfläche darf hier NICHT das zurückbekommen, was sie
   * geschickt hat, sondern das, was der Server daraus gemacht hat: sonst sähe
   * die Redaktion Formatierungen, die nie hinausgehen.
   */
  contentHtml: string | null;
  placeholders: string[];
  active: boolean;
  /**
   * Die vier Strukturfelder der Werbemail. `null`, wo nichts steht.
   *
   * Sie kommen AUCH BEI TRANSAKTIONSVORLAGEN mit — dort stehen sie nie auf
   * `null`-verschieden, weil der Transaktionsrahmen sie nicht kennt. Sie
   * herauszufiltern hiesse, zwei Antwortformen zu haben.
   */
  eyebrow: string | null;
  heading: string | null;
  buttonText: string | null;
  buttonTarget: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PreviewResponse {
  subject: string;
  /**
   * Der Rumpf als reiner Text — die Fassung, die Postfächer zeigen, die kein
   * HTML darstellen. Ohne Rahmen und ohne Fusszeile.
   */
  body: string;
  /**
   * DAS VOLLSTÄNDIGE DOKUMENT, so wie es hinausgeht: Kopf, Rumpf und die
   * kanalgerechte Fusszeile.
   *
   * Vorher lieferte die Vorschau nur den Rumpf. Die Oberfläche konnte die
   * Fusszeile deshalb nicht zeigen und hat sie — richtigerweise — auch nicht
   * nachgebaut: Eine zweite Fassung einer Pflichtangabe nach § 5 DDG im
   * Browser liefe der Quelle davon. Also liefert der Server sie.
   */
  html: string;
  /** Der vollständige Textteil, mit Fusszeile — das zweite, was hinausgeht. */
  text: string;
  /** Welche Platzhalter mit welchem Beispielwert gefüllt wurden. */
  used: Record<string, string>;
}

/**
 * DER REDAKTIONSBEREICH — Vorlagen, Platzhalter, Vorschau.
 *
 * Zwei Festlegungen, die den Rest tragen:
 *
 * 1. DER KANAL STEHT AN DER VORLAGE UND IST UNVERÄNDERLICH. Beim Anlegen wird
 *    entschieden, ob es eine Transaktions- oder eine Werbemail ist; danach
 *    nicht mehr. Wäre er änderbar, liesse sich eine Werbebotschaft
 *    nachträglich zur Transaktionsmail erklären und an Leute schicken, die nie
 *    eingewilligt haben — R3 wäre über einen Datenbankwert aushebelbar.
 * 2. PLATZHALTER WERDEN BEIM SPEICHERN GEPRÜFT, nicht erst beim Versand. Ein
 *    Tippfehler soll auffallen, während jemand die Vorlage schreibt.
 *
 * Was hier NICHT entschieden wird: wer die Mail bekommt. Das entscheidet
 * ausschliesslich das Tor beim Versand.
 */
@Injectable()
export class TemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    // FÜR DIE VORSCHAU, nicht für den Versand: Die Vorschau muss dasselbe
    // Dokument zeigen, das hinausgeht — samt Fusszeile und Anbieterkennung.
    // Sie hier ein zweites Mal zusammenzusetzen hiesse, zwei Fassungen einer
    // Pflichtangabe zu pflegen.
    private readonly marketingMail: MarketingMailService,
  ) {}

  async list(channel?: MailChannel): Promise<TemplateResponse[]> {
    const rows = await this.prisma.mailTemplate.findMany({
      where: channel ? { channel } : {},
      orderBy: { name: 'asc' },
    });
    return rows.map(asResponse);
  }

  /** Wie viele Vorlagen es gibt — für die Zahl am Reiter. */
  async count(): Promise<number> {
    return this.prisma.mailTemplate.count();
  }

  async get(id: string): Promise<TemplateResponse> {
    return asResponse(await this.loadRaw(id));
  }

  async create(
    dto: {
      name: string;
      channel: MailChannel;
      subject: string;
      contentText?: string;
      contentHtml?: string;
      placeholders?: string[];
      eyebrow?: string;
      heading?: string;
      buttonText?: string;
      buttonTarget?: string;
    },
    actor: Actor,
    source: InquirySource,
  ): Promise<TemplateResponse> {
    const allowed = dto.placeholders ?? [];
    const content = contentFrom(dto);
    checkContentLength(content.text);
    this.checkPlaceholder(dto.subject, content.text, allowed);

    const row = await this.prisma.mailTemplate.create({
      data: {
        name: dto.name.trim(),
        channel: dto.channel,
        subject: dto.subject,
        contentText: content.text,
        contentHtml: content.html,
        placeholders: allowed.length > 0 ? allowed.join(',') : null,
        ...structure(dto),
      },
    });
    await this.audit.log({
      userId: actor.userId,
      actor: actor.name,
      action: AUDIT_ACTION.broadcastTemplateCreated,
      objectType: 'MailTemplate',
      objectId: row.id,
      // KEIN Wortlaut im Nachweis: Er kann Namen enthalten, und das Audit-Log
      // hat keinen Löschweg. Die Vorlage selbst steht in der Tabelle.
      afterValue: {
        channel: row.channel,
        length: row.contentText.length,
        placeholders: allowed,
      },
      ...source,
    });
    return asResponse(row);
  }

  async change(
    id: string,
    dto: {
      subject?: string;
      contentText?: string;
      contentHtml?: string;
      placeholders?: string[];
      active?: boolean;
      eyebrow?: string;
      heading?: string;
      buttonText?: string;
      buttonTarget?: string;
    },
    actor: Actor,
    source: InquirySource,
  ): Promise<TemplateResponse> {
    const before = await this.loadRaw(id);
    const subject = dto.subject ?? before.subject;
    // Ohne neuen Inhalt bleibt der alte STEHEN — beide Spalten unverändert.
    // Ihn durch den Säuberer zu schicken wäre hier falsch: Er ist schon
    // gesäubert, und ein zweiter Lauf über eine reine Textvorlage machte aus
    // ihr eine HTML-Vorlage, die niemand angelegt hat.
    const content =
      dto.contentHtml === undefined && dto.contentText === undefined
        ? { text: before.contentText, html: before.contentHtml }
        : contentFrom(dto);
    const allowed = dto.placeholders ?? placeholderFrom(before.placeholders);
    checkContentLength(content.text);
    this.checkPlaceholder(subject, content.text, allowed);

    const row = await this.prisma.mailTemplate.update({
      where: { id },
      data: {
        subject,
        contentText: content.text,
        contentHtml: content.html,
        placeholders: allowed.length > 0 ? allowed.join(',') : null,
        active: dto.active ?? before.active,
        // WAS NICHT GESCHICKT WIRD, BLEIBT STEHEN. Ein leerer Text dagegen
        // LÖSCHT das Feld — wer eine Überschrift herausnimmt, will sie weg
        // haben. Die Unterscheidung trifft `struktur`, nicht der Aufrufer.
        ...structure(dto),
        // `kanal` und `name` stehen bewusst NICHT in dieser Liste. Der Kanal
        // ist unveränderlich (siehe Klassenkommentar), der Name ist die
        // Kennung, unter der die Vorlage im Verlauf auftaucht.
      },
    });
    await this.audit.log({
      userId: actor.userId,
      actor: actor.name,
      action: AUDIT_ACTION.broadcastTemplateUpdated,
      objectType: 'MailTemplate',
      objectId: id,
      beforeValue: { length: before.contentText.length, active: before.active },
      afterValue: { length: row.contentText.length, active: row.active },
      ...source,
    });
    return asResponse(row);
  }

  /**
   * Vorschau mit BEISPIELWERTEN. Verschickt nichts.
   *
   * Die Beispielwerte sind erkennbar Beispiele („Beispielorganisation") und
   * keine echten Daten: Eine Vorschau, die den ersten Datensatz der Datenbank
   * einsetzt, zeigt eine fremde Organisation an einer Stelle, an der niemand
   * damit rechnet.
   */
  async preview(
    id: string,
    examples: Record<string, string> = {},
  ): Promise<PreviewResponse> {
    const template = await this.loadRaw(id);
    const values: Record<string, string> = {
      organisation: 'Beispielorganisation',
      // ERKENNBAR EIN BEISPIEL — und ohne spitze Klammern: Die Vorschau ist
      // jetzt HTML, und `<token>` erschiene dort als `&lt;token&gt;`. Das sähe
      // aus wie ein Fehler des Rahmens statt wie ein Platzhalter.
      abmeldelink: 'https://…/api/consent/unsubscribe/beispiel-token',
      ...Object.fromEntries(
        placeholderFrom(template.placeholders).map((name) => [
          name,
          `<${name}>`,
        ]),
      ),
      ...examples,
    };
    const subject = replace(template.subject, values);
    const bodyText = replace(template.contentText, values);
    const bodyHtml = replaceInHtml(
      template.contentHtml ?? htmlFromText(template.contentText),
      values,
    );

    // DIE VORSCHAU ZEIGT DAS GANZE DOKUMENT, nicht den Rumpf.
    //
    // Die Fusszeile ist der Teil, den die Redaktion NICHT ändern kann und
    // gerade deshalb sehen muss: Abmeldelink und Anbieterkennung sind
    // Pflichtangaben, und wer sie in der Vorschau nicht sieht, kann nicht
    // beurteilen, was hinausgeht. Gebaut wird sie über DENSELBEN Weg wie beim
    // Versand — eine zweite Fassung liefe der Quelle davon.
    //
    // Der Kanal entscheidet, welcher der beiden Wege genommen wird, und er
    // steht unveränderlich an der Vorlage. Es gibt hier keinen Parameter, mit
    // dem sich das umstellen liesse.
    const mail =
      template.channel === 'marketing'
        ? this.marketingMail.wording(
            {
              subject,
              html: bodyHtml,
              text: bodyText,
              // MIT den Strukturfeldern: Die Vorschau zeigt, was hinausgeht,
              // und dazu gehören Vorüberschrift, Überschrift und Knopf.
              eyebrow: template.eyebrow,
              heading: template.heading,
              buttonText: template.buttonText,
              buttonTarget: template.buttonTarget,
            },
            values.abmeldelink!,
          )
        : transactionalLayout({ subject, html: bodyHtml, text: bodyText });

    return {
      subject,
      body: bodyText,
      html: mail.html,
      text: mail.text,
      used: values,
    };
  }

  /** Lädt eine Vorlage und stellt sicher, dass sie versandfähig ist. */
  async loadSendable(id: string, channel: MailChannel) {
    const template = await this.loadRaw(id);
    if (template.channel !== channel) {
      throw new TemplateWrongChannelError(template.channel);
    }
    if (!template.active) throw new TemplateNotActiveError();
    return template;
  }

  // ----------------------------------------------------------------- intern

  private async loadRaw(id: string) {
    const row = await this.prisma.mailTemplate.findUnique({ where: { id } });
    if (!row) throw new TemplateNotFoundError();
    return row;
  }

  private checkPlaceholder(
    subject: string,
    content: string,
    allowed: readonly string[],
  ): void {
    const unknown = [
      ...unknownPlaceholder(subject, allowed),
      ...unknownPlaceholder(content, allowed),
    ];
    const withoutDuplicates = [...new Set(unknown)];
    if (withoutDuplicates.length > 0) {
      throw new UnknownPlaceholderError(withoutDuplicates);
    }
  }
}

/** Zerlegt die kommagetrennte Platzhalterliste. */
export function placeholderFrom(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * Macht aus dem, was der Client geschickt hat, die beiden Fassungen, die
 * gespeichert werden.
 *
 * ZWEI FESTLEGUNGEN, DIE ZUSAMMENGEHÖREN:
 *
 * 1. `inhaltHtml` ist die Eingabe, und sie ist UNGEPRÜFT. Sie läuft durch
 *    `saeubere()`, bevor irgendetwas gespeichert wird — das ist die
 *    massgebliche Prüfung, nicht die im Browser. Was hier nicht durchkommt,
 *    kommt nirgends durch.
 * 2. `inhaltText` wird vom SERVER ABGELEITET und nicht vom Client
 *    entgegengenommen, sobald HTML da ist. Zwei unabhängig gelieferte
 *    Fassungen liefen auseinander, und die Person, die die Vorschau liest,
 *    sähe etwas anderes, als Postfächer ohne HTML anzeigen.
 *
 * Ohne `inhaltHtml` bleibt alles wie vorher: reiner Text, keine HTML-Spalte.
 * Vorlagen aus der Zeit vor dem Redaktionsfeld ändern sich dadurch nicht.
 */
/**
 * Die Längengrenze auf der ABGELEITETEN Textfassung.
 *
 * Die DTOs prüfen die Eingabe (20 000 Zeichen Text, 60 000 Zeichen HTML), aber
 * nicht das Ergebnis. Ein HTML-Rumpf aus 40 000 Zeichen Auszeichnung und drei
 * Wörtern Inhalt käme dort durch — hier nicht.
 */
function checkContentLength(text: string): void {
  const length = text.trim().length;
  if (length < CONTENT_MIN_CHARACTERS || length > CONTENT_MAX_CHARACTERS) {
    throw new TemplateContentError(
      length,
      CONTENT_MIN_CHARACTERS,
      CONTENT_MAX_CHARACTERS,
    );
  }
}

function contentFrom(dto: {
  contentText?: string;
  contentHtml?: string;
}): { text: string; html: string | null } {
  if (dto.contentHtml !== undefined) {
    const html = sanitize(dto.contentHtml);
    return { text: textFrom(html), html };
  }
  return { text: dto.contentText ?? '', html: null };
}

/**
 * Die vier Strukturfelder aus einem DTO in Spaltenwerte.
 *
 * DREI ZUSTÄNDE, NICHT ZWEI: Ein Feld kann fehlen (bleibt stehen), einen
 * Text tragen (wird geschrieben) oder LEER geschickt werden (wird gelöscht).
 * Ohne den dritten liesse sich eine einmal gesetzte Überschrift nie wieder
 * loswerden — genau die Falle, in die ein `?? vorher` läuft.
 */
function structure(dto: {
  eyebrow?: string;
  heading?: string;
  buttonText?: string;
  buttonTarget?: string;
}): Record<string, string | null> {
  const fields = [
    'eyebrow',
    'heading',
    'buttonText',
    'buttonTarget',
  ] as const;
  const data: Record<string, string | null> = {};
  for (const field of fields) {
    const value = dto[field];
    if (value === undefined) continue;
    data[field] = value.trim() === '' ? null : value.trim();
  }
  return data;
}

function asResponse(row: {
  id: string;
  name: string;
  channel: MailChannel;
  subject: string;
  contentText: string;
  contentHtml: string | null;
  placeholders: string | null;
  active: boolean;
  eyebrow: string | null;
  heading: string | null;
  buttonText: string | null;
  buttonTarget: string | null;
  createdAt: Date;
  updatedAt: Date;
}): TemplateResponse {
  return {
    id: row.id,
    name: row.name,
    channel: row.channel,
    subject: row.subject,
    contentText: row.contentText,
    contentHtml: row.contentHtml,
    placeholders: [...DEFAULT_PLACEHOLDER, ...placeholderFrom(row.placeholders)],
    active: row.active,
    eyebrow: row.eyebrow,
    heading: row.heading,
    buttonText: row.buttonText,
    buttonTarget: row.buttonTarget,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
