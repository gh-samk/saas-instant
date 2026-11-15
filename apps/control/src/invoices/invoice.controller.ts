import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { SessionUser } from '../auth/session.service';
import { sourceFrom } from '../common/inquiry-source';
import { LoggedInUser } from '../common/decorators/logged-in-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import { InvoiceDocumentService, type DocumentFormat } from './document.service';
import { PricingService } from './pricing.service';
import { IntegrityService } from './integrity.service';
import type { IntegrityResult } from './integrity';
import { InvoiceHistoryService, type HistoryEntry } from './invoice-history.service';
import type { PriceSuggestion } from './pricing.types';
import {
  InvoiceService,
  type Actor,
  type InvoiceMetrics,
  type InvoicePage,
} from './invoice.service';
import type { InvoiceResponse } from './invoice.response';
import {
  PriceSuggestionQueryDto,
  InvoiceDraftUpdateDto,
  InvoiceDraftDto,
  InvoiceMetricsDto,
  InvoiceListDto,
} from './dto/invoice.dto';

/** Der angemeldete Benutzer als Akteur des Audit-Logs. */
export function asActor(user: SessionUser): Actor {
  return { userId: user.id, name: user.username };
}

/**
 * DAS RECHNUNGSMODUL AN DER ORGANISATION.
 *
 * SCHUTZ: `SessionGuard` auf Klassenebene plus der global registrierte
 * `CsrfGuard`. KEIN zweiter Faktor — und die Begründung dafür wurde mit [K3]
 * ausgetauscht, weil die alte falsch war.
 *
 * ALT (und widerlegt): „Anlegen, Festschreiben und Stornieren hinterlassen ein
 * Dokument, der Zahlungsstand nicht." Das stimmt so nicht: Der Zahlungsstand
 * schreibt sehr wohl Vorher/Nachher ins Audit-Log, und ein Storno lässt eine
 * Forderung genauso lautlos verschwinden wie ein falscher Zahlungsvermerk.
 *
 * NEU, UND DAS IST DAS EIGENTLICHE KRITERIUM: **Lässt sich der Vorgang
 * zurücknehmen?** Ein Zahlungsvermerk lässt sich korrigieren. Eine vergebene
 * Rechnungsnummer, ein Storno und eine verschickte Mail nicht.
 *
 * Deshalb steht HIER nur, was ein Entwurf ist oder rein liest — anlegen,
 * ändern, löschen, ansehen, Dokument abrufen. Alles Unumkehrbare liegt am
 * `InvoiceCompletionController` hinter dem `SecondFactorGuard`, der
 * Zahlungsstand wie bisher am `InvoicePaymentController`.
 *
 * ES GIBT HIER GENAU EINE LÖSCHROUTE, und sie heißt nicht zufällig
 * `entwurf`: `DELETE :id/entwurf`. Für eine festgeschriebene Rechnung
 * existiert weder ein `DELETE` noch ein `PATCH` — nicht als abgewiesener
 * Aufruf, sondern als fehlende Route (R2). `invoice-immutable.spec.ts`
 * zählt das über den Quellbaum ab.
 */
@Controller()
@UseGuards(SessionGuard)
export class InvoiceController {
  constructor(
    private readonly invoices: InvoiceService,
    private readonly prices: PricingService,
    private readonly documents: InvoiceDocumentService,
    private readonly integrity: IntegrityService,
    private readonly history: InvoiceHistoryService,
  ) {}

  // ------------------------------------------------------------ Preislogik

  /**
   * DER STUFENVORSCHLAG — R5: er wird angezeigt, die Benutzerin bestätigt.
   *
   * Rein lesend. Diese Route setzt keine Preisstufe; das tut ausschließlich
   * die Betreiberin über `PATCH /companies/:id`.
   */
  @Get('companies/:id/price-suggestion')
  async priceSuggestion(
    @Param('id') id: string,
    @Query() query: PriceSuggestionQueryDto,
  ): Promise<PriceSuggestion> {
    return this.prices.suggestion(id, query.cutoffDate);
  }

  // -------------------------------------------------------------- Entwürfe

  @Get('companies/:id/invoices')
  async list(@Param('id') id: string): Promise<InvoiceResponse[]> {
    return this.invoices.listForCompany(id);
  }

  @Post('companies/:id/invoices')
  @HttpCode(201)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async draftCreate(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Body() dto: InvoiceDraftDto,
    @Req() req: Request,
  ): Promise<InvoiceResponse> {
    return this.invoices.draftCreate(
      id,
      dto,
      asActor(user),
      sourceFrom(req),
    );
  }

  // ------------------------------------------------- Globale Rechnungsliste

  /**
   * ALLE Rechnungen, gefiltert und mit Seiten.
   *
   * SIE MUSS VOR `rechnungen/:id` STEHEN. Nest prueft die Routen in der
   * Reihenfolge ihrer Deklaration; stuende sie danach, faenge `:id` den Pfad
   * `rechnungen/kennzahlen` ab und suchte eine Rechnung mit der Kennung
   * „kennzahlen".
   */
  @Get('invoices')
  async allInvoices(
    @Query() query: InvoiceListDto,
  ): Promise<InvoicePage> {
    return this.invoices.list(query);
  }

  @Get('invoices/metrics')
  async metrics(
    @Query() query: InvoiceMetricsDto,
  ): Promise<InvoiceMetrics> {
    return this.invoices.metrics(query.year);
  }

  @Get('invoices/:id')
  async detail(@Param('id') id: string): Promise<InvoiceResponse> {
    return this.invoices.get(id);
  }

  /**
   * INTEGRITAETSPRUEFUNG (GoBD): SHA-256 der gespeicherten Dokumente gegen die
   * beim Erzeugen festgehaltenen Pruefsummen, dazu der Nummernkreis des Jahres.
   * Rein lesend; eine Abweichung steht zusaetzlich im Audit-Log.
   */
  @Get('invoices/:id/integrity')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async integrityCheck(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<IntegrityResult> {
    return this.integrity.check(id, asActor(user), sourceFrom(req));
  }

  /** Der Verlauf der Rechnung aus dem Audit-Log: Benutzer, Zeit (UTC), Aktion. */
  @Get('invoices/:id/history')
  async historyOf(@Param('id') id: string): Promise<HistoryEntry[]> {
    return this.history.history(id);
  }

  /**
   * Ändert einen ENTWURF.
   *
   * Der Pfad sagt es und der Dienst prüft es. Wer die Kennung einer
   * festgeschriebenen Rechnung schickt, bekommt einen Konflikt — das ist die
   * zweite von zwei Ebenen, mit denen R2 durchgesetzt wird.
   */
  @Patch('invoices/:id/draft')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async draftUpdate(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Body() dto: InvoiceDraftUpdateDto,
    @Req() req: Request,
  ): Promise<InvoiceResponse> {
    return this.invoices.draftUpdate(
      id,
      dto,
      asActor(user),
      sourceFrom(req),
    );
  }

  /** Löscht einen ENTWURF. Der einzige Löschweg des Moduls. */
  @Delete('invoices/:id/draft')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async draftDelete(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<{ deleted: true }> {
    return this.invoices.draftDelete(
      id,
      asActor(user),
      sourceFrom(req),
    );
  }

  // ------------------------------------------------------ Dokument, Versand

  /**
   * Das ZUGFeRD-PDF (PDF/A-3b mit eingebettetem `factur-x.xml`).
   *
   * Erzeugt es beim ersten Aufruf und gibt danach immer dasselbe heraus.
   * `GET`, obwohl beim ersten Mal etwas geschrieben wird: Das Geschriebene ist
   * das Dokument zu einem bereits bestehenden Beleg, kein neuer Vorgang.
   * JEDER Abruf wird protokolliert (`invoice.document_downloaded`).
   */
  @Get('invoices/:id/document')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async document(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Req() req: Request,
    @Res() response: Response,
  ): Promise<void> {
    await this.send('pdf', id, user, req, response);
  }

  /** Dieselbe Rechnung als reines Factur-X-CII-XML (EN 16931) für die Buchhaltung. */
  @Get('invoices/:id/xml')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async xml(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Req() req: Request,
    @Res() response: Response,
  ): Promise<void> {
    await this.send('xml', id, user, req, response);
  }

  /**
   * Die XRechnung (CII 3.0) als reines XML — für Behörden. Unabhängig vom PDF.
   */
  @Get('invoices/:id/xrechnung')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async xrechnung(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Req() req: Request,
    @Res() response: Response,
  ): Promise<void> {
    await this.send('xrechnung', id, user, req, response);
  }

  private async send(
    format: DocumentFormat,
    id: string,
    user: SessionUser,
    req: Request,
    response: Response,
  ): Promise<void> {
    const { content, filename, contentType } = await this.documents.download(
      format,
      id,
      asActor(user),
      sourceFrom(req),
    );
    response
      .status(200)
      .setHeader('Content-Type', contentType)
      .setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      .send(content);
  }
}
