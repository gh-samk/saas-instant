import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '../auth/session.service';
import { sourceFrom } from '../common/inquiry-source';
import { LoggedInUser } from '../common/decorators/logged-in-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import type {
  RecipientRow,
  EvidenceRow,
  BlockRow,
} from '../consent/consent.service';
import type { BroadcastCount } from './broadcast.types';
import { ConsentService } from '../consent/consent.service';
import { TemplateChangeDto, TemplateCreateDto } from './dto/broadcast.dto';
import type { TemplateResponse, PreviewResponse } from './template.service';
import { TemplateService } from './template.service';
import type { SendProgress } from './queue.service';
import { QueueService } from './queue.service';

/** Was die Empfängerauswahl VOR dem Absenden liefert. */
export interface RecipientSelection {
  count: number;
  recipient: RecipientRow[];
  note: string;
}

/**
 * DER REDAKTIONSBEREICH — Vorlagen, Vorschau, Empfängerauswahl.
 *
 * Alles hier ist entweder lesend oder betrifft einen ENTWURF: eine Vorlage
 * schreiben, sie ansehen, sehen wer sie bekäme. Es geht auf keiner dieser
 * Routen eine Mail hinaus. Das Verschicken liegt am
 * `RundmailVersandController` — hinter dem zweiten Faktor.
 *
 * Deshalb genügt hier die Sitzung: Eine Vorlage zu ändern hinterlässt einen
 * Audit-Eintrag, ist jederzeit korrigierbar und erreicht niemanden. Alle zehn
 * Minuten das Passwort für das Redigieren eines Textes zu verlangen machte die
 * Arbeit unmöglich und gewöhnte die Betreiberin daran, es auf Zuruf
 * einzutippen ([W6]).
 *
 * DER FORTSCHRITT GEHÖRT AUS DEMSELBEN GRUND HIERHER und nicht an den
 * Versandcontroller: Er ist reines Ablesen. Er stösst keinen Lauf an, er
 * verschickt nichts, und er gibt keine Adresse heraus — nur Zählwerte. Ihn
 * hinter den zweiten Faktor zu legen hiesse, alle paar Sekunden während eines
 * laufenden Versands das Passwort zu verlangen; genau die Gewöhnung, die [W6]
 * beschreibt. (Technisch ginge es ohnehin nicht: Der `ZweitfaktorGuard` liest
 * den Nachweis aus dem Body, und ein GET hat keinen.)
 */
@Controller('broadcast')
@UseGuards(SessionGuard)
export class BroadcastController {
  constructor(
    private readonly templates: TemplateService,
    private readonly consents: ConsentService,
    private readonly queue: QueueService,
  ) {}

  @Get('templates')
  async list(): Promise<TemplateResponse[]> {
    return this.templates.list();
  }

  @Get('templates/:id')
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<TemplateResponse> {
    return this.templates.get(id);
  }

  @Post('templates')
  async create(
    @Body() dto: TemplateCreateDto,
    @LoggedInUser() user: SessionUser,
    @Req() req: Request,
  ): Promise<TemplateResponse> {
    return this.templates.create(
      dto,
      { userId: user.id, name: user.username },
      sourceFrom(req),
    );
  }

  @Patch('templates/:id')
  async change(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TemplateChangeDto,
    @LoggedInUser() user: SessionUser,
    @Req() req: Request,
  ): Promise<TemplateResponse> {
    return this.templates.change(
      id,
      dto,
      { userId: user.id, name: user.username },
      sourceFrom(req),
    );
  }

  /** Vorschau mit Beispielwerten. Verschickt nichts. */
  @Get('templates/:id/preview')
  async preview(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PreviewResponse> {
    return this.templates.preview(id);
  }

  /**
   * WIE WEIT DER VERSAND DIESER VORLAGE IST — vier Zahlen und die Summe.
   *
   * Gedacht zum wiederholten Abrufen, solange `offen` grösser als null ist.
   * Die Antwort enthält keine Adresse und keine Kennung einer Empfängerin; sie
   * entsteht über eine Zählung und kann gar keine Zeile herausgeben.
   */
  @Get('templates/:id/progress')
  async progress(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SendProgress> {
    return this.queue.progress(id);
  }

  /**
   * WER GENAU DIE MAIL BEKOMMT UND WIE VIELE ES SIND.
   *
   * Der Auftrag verlangt diese Auskunft ausdrücklich VOR dem Absenden. Sie ist
   * aber eine Vorhersage und keine Zusage — massgeblich bleibt die Prüfung
   * beim Versand (R3). Der Hinweis in der Antwort sagt das auch, damit niemand
   * die Liste für eine Zusage hält.
   */
  @Get('recipients')
  async recipient(): Promise<RecipientSelection> {
    const recipient = await this.consents.recipient();
    return {
      count: recipient.length,
      recipient,
      note:
        'Stand jetzt. Massgeblich ist die Prüfung unmittelbar vor dem ' +
        'Versand: Wer bis dahin widerruft, bekommt nichts.',
    };
  }

  /**
   * Der vollständige Nachweis zu einer Adresse — Formulartext im Wortlaut,
   * beide IP-Adressen, beide Zeitpunkte.
   *
   * Das ist der Grund, warum überhaupt etwas gespeichert wird: Im Streitfall
   * zählt nicht, dass jemand zugestimmt hat, sondern dass sich zeigen lässt,
   * wozu. Die Token selbst stehen NICHT in der Antwort — wer den Abmeldetoken
   * einer fremden Adresse liest, kann sie abmelden.
   */
  /**
   * DIE SPERRLISTE — wer nichts Werbliches mehr bekommt.
   *
   * Rein lesend, deshalb hier und nicht am `EinwilligungSperreController`:
   * Der steht hinter dem zweiten Faktor, weil eine Sperre nicht
   * zurücknehmbar ist. Sie ANZUSEHEN ändert nichts.
   *
   * Der Anlass steht mit in der Antwort. Er ist ein Freitext über eine
   * Person — dass er hier herausgeht, ist der Grund, warum diese Route die
   * Sitzung verlangt und nicht öffentlich ist.
   */
  /**
   * DIE DREI ZAHLEN DER REITERLEISTE — und sonst nichts.
   *
   * Die Leiste zeigt auf jedem Reiter alle drei Zählwerte. Sie aus den Listen
   * abzuleiten hiesse, auf dem Reiter „Sperrliste" die vollständige
   * Einwilligungsliste zu laden, nur um ihre Länge anzuzeigen — bei
   * hundertachtundzwanzig Adressen ein Datensatz je Zahl.
   *
   * REIN ZÄHLEND. Es geht keine Adresse heraus.
   */
  @Get('counters')
  async count(): Promise<BroadcastCount> {
    const [templates, addresses] = await Promise.all([
      this.templates.count(),
      this.consents.count(),
    ]);
    return { templates, ...addresses };
  }

  @Get('blocklist')
  async blocklist(): Promise<BlockRow[]> {
    return this.consents.blocklist();
  }

  @Get('evidence')
  async evidence(
    @Query('email') email?: string,
  ): Promise<EvidenceRow | null> {
    if (!email || email.trim() === '') return null;
    return this.consents.evidence(email);
  }
}
