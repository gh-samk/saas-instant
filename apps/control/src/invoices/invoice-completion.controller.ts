import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { SessionUser } from '../auth/session.service';
import { sourceFrom } from '../common/inquiry-source';
import { LoggedInUser } from '../common/decorators/logged-in-user.decorator';
import { BusinessError } from '../common/errors/business-error';
import { SessionGuard } from '../common/guards/session.guard';
import { SecondFactorGuard } from '../common/guards/second-factor.guard';
import { FinalizeDto, CancellationDto, SendEvidenceDto } from './dto/invoice.dto';
import { asActor } from './invoice.controller';
import type { InvoiceResponse } from './invoice.response';
import { InvoiceService } from './invoice.service';
import { InvoiceSendService } from './send.service';

/**
 * Die ausdrückliche Bestätigung des Festschreibens.
 *
 * Wörtlich `festschreiben`. Nach diesem Aufruf gibt es keinen Weg zurück ausser
 * einer Stornorechnung — dafür soll ein versehentlich abgeschicktes Formular
 * nicht genügen. Dieselbe Bauweise wie bei der Kontaktdatenlöschung, wo der
 * Organisationsname getippt werden muss.
 *
 * Sie ersetzt den zweiten Faktor NICHT und wurde nie dafür gehalten: Ein
 * getippter Text beweist, dass jemand es ernst meint; er beweist nicht, WER am
 * Gerät sitzt. Genau das war der Kern von [K3].
 */
export const FINALIZE_CONFIRMATION = 'festschreiben';

export class ConfirmationMissingError extends BusinessError {
  constructor() {
    super(
      'confirmation_missing',
      `Zum Festschreiben muss „${FINALIZE_CONFIRMATION}" bestätigt ` +
        'werden. Danach lässt sich die Rechnung nicht mehr ändern.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * ===========================================================================
 * WAS SICH NICHT ZURÜCKNEHMEN LÄSST — hinter dem `SecondFactorGuard` ([K3])
 * ===========================================================================
 *
 * DIE ALTE ABGRENZUNG WAR FALSCH. Sie lautete: „Anlegen, Festschreiben und
 * Stornieren hinterlassen ein Dokument, der Zahlungsstand hinterlässt keines."
 * Drei Punkte widerlegen sie:
 *
 * 1. Der Zahlungsstand hinterlässt sehr wohl eine Spur — `PaymentService`
 *    schreibt Vorher/Nachher ins Audit-Log.
 * 2. Ein Storno lässt eine Forderung genauso lautlos aus der Übersicht
 *    verschwinden wie ein falscher Zahlungsvermerk. Das „Dokument" macht den
 *    Schaden nicht kleiner, es dokumentiert ihn nur.
 * 3. Und entscheidend: **Ein Zahlungsvermerk lässt sich korrigieren. Eine
 *    vergebene Rechnungsnummer, ein Storno und eine verschickte Mail nicht.**
 *
 * GEMESSEN mit einem selbst signierten, eine Stunde alten Sitzungs-Cookie:
 * `FESTSCHREIBEN 200 → 2026-078`, `STORNIEREN 201 → 2026-079`, `ZAHLUNG 401`.
 * Der zweite Faktor sass auf der umkehrbaren Handlung und fehlte auf den
 * unumkehrbaren. Bei zehn Aufrufen je Minute sind das 600 Stornos in der
 * Stunde — jedes einzelne ein Beleg, der zehn Jahre aufbewahrt werden muss.
 *
 * DAS KRITERIUM LAUTET AB HIER: *Lässt sich der Vorgang zurücknehmen?*
 *
 *   festschreiben  verbrennt eine Rechnungsnummer, die nie wieder frei wird
 *   stornieren     hebt eine Forderung endgültig auf
 *   versenden      eine verschickte Mail holt niemand zurück
 *   erinnerung     dasselbe, und sie geht an eine Kundin
 *
 * ALLE ROUTEN SIND POST — dieselbe Begründung wie am
 * `InvoicePaymentController`: Der `SecondFactorGuard` liest den Nachweis
 * (`currentPassword` oder `totpCode`) aus dem Body, und ein GET hat keinen.
 * Die Ausnahme für eine FRISCHE Sitzung (unter zehn Minuten) gilt auch hier —
 * wer eine Rechnung nach der anderen abarbeitet, tippt sein Passwort einmal.
 */
@Controller()
@UseGuards(SessionGuard, SecondFactorGuard)
export class InvoiceCompletionController {
  constructor(
    private readonly invoices: InvoiceService,
    private readonly sender: InvoiceSendService,
  ) {}

  /**
   * FESTSCHREIBEN: Nummer vergeben, Schnappschuss einfrieren, unveränderlich
   * machen.
   *
   * Ein enges Rate-Limit, obwohl der Vorgang harmlos aussieht: Er verbraucht
   * eine Rechnungsnummer, und zwanzig versehentliche Doppelklicks ergäben
   * zwanzig Belege, die alle storniert werden müssten.
   */
  @Post('invoices/:id/finalize')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async finalize(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Body() dto: FinalizeDto,
    @Req() req: Request,
  ): Promise<InvoiceResponse> {
    if (dto.confirmation.trim() !== FINALIZE_CONFIRMATION) {
      throw new ConfirmationMissingError();
    }
    return this.invoices.finalize(
      id,
      asActor(user),
      sourceFrom(req),
    );
  }

  /**
   * STORNIEREN: neue Rechnung mit negativem Betrag, gegenseitiger Verweis,
   * beide bleiben bestehen.
   *
   * Der einzige Weg, eine festgeschriebene Rechnung zu korrigieren — und
   * deshalb vom ersten Tag an vorhanden. Ohne ihn bliebe nur ein Eingriff in
   * die Datenbank, und genau der ist ausgeschlossen.
   */
  @Post('invoices/:id/cancel')
  @HttpCode(201)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async cancel(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Body() dto: CancellationDto,
    @Req() req: Request,
  ): Promise<{ original: InvoiceResponse; cancellation: InvoiceResponse }> {
    return this.invoices.cancel(
      id,
      dto.reason,
      asActor(user),
      sourceFrom(req),
    );
  }

  /** Schickt die Rechnung samt PDF an die Empfängeradresse des Schnappschusses. */
  @Post('invoices/:id/send')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async send(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Body() _dto: SendEvidenceDto,
    @Req() req: Request,
  ): Promise<InvoiceResponse> {
    return this.sender.send(id, asActor(user), sourceFrom(req));
  }

  /** Zahlungserinnerung. Auch sie geht an eine Kundin und ist nicht rückholbar. */
  @Post('invoices/:id/reminder')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async reminder(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Body() _dto: SendEvidenceDto,
    @Req() req: Request,
  ): Promise<InvoiceResponse> {
    return this.sender.remind(id, asActor(user), sourceFrom(req));
  }
}
