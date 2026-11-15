import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { SessionUser } from '../auth/session.service';
import { sourceFrom } from '../common/inquiry-source';
import { LoggedInUser } from '../common/decorators/logged-in-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import { SecondFactorGuard } from '../common/guards/second-factor.guard';
import { BroadcastSendDto } from './dto/broadcast.dto';
import type {
  EnqueueResult,
  SendRunResult,
} from './queue.service';
import { QueueService } from './queue.service';

/**
 * ===========================================================================
 * DER VERSAND — hinter dem `ZweitfaktorGuard`
 * ===========================================================================
 *
 * Dasselbe Kriterium wie beim Zahlungsstand aus Etappe 4, auf Rundmails
 * angewandt — und es fällt hier noch deutlicher aus:
 *
 * EINE VERSCHICKTE MAIL LÄSST SICH NICHT ZURÜCKHOLEN. Wer mit einem erbeuteten
 * Sitzungs-Cookie eine Rundmail einstellt, schreibt im Namen des Hauses an
 * jede Adresse, die je eingewilligt hat. Es gibt keinen Storno, keine
 * Korrekturbuchung und keinen zweiten Beleg, der den ersten aufhebt — anders
 * als bei einer Rechnung. Der Schaden ist der Ruf, und der ist genau das, was
 * die Zustellbarkeit der Domäne trägt: Sind die Rundmails erst als Spam
 * eingestuft, kommen auch die Rechnungen nicht mehr an.
 *
 * Die REDAKTION bleibt ausdrücklich ohne zweiten Faktor
 * (`RundmailController`). Wer Texte schreibt, erreicht damit niemanden.
 *
 * ALLE ROUTEN SIND POST — dieselbe Begründung wie am
 * `RechnungZahlungController`: Der `ZweitfaktorGuard` liest den Nachweis aus
 * dem Body, und ein GET hat keinen. Die Ausnahme für eine frische Sitzung
 * (unter zehn Minuten) gilt auch hier.
 */
@Controller('broadcast')
@UseGuards(SessionGuard, SecondFactorGuard)
export class BroadcastSendController {
  constructor(private readonly queue: QueueService) {}

  /**
   * Stellt die Rundmail für alle bestätigten Adressen ein.
   *
   * ES GEHT HIER NOCH NICHTS HINAUS. Der Versandlauf nimmt die Zeilen einzeln
   * auf und prüft für jede erneut die Einwilligung.
   */
  @Post('templates/:id/send')
  @HttpCode(200)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async enqueue(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() _dto: BroadcastSendDto,
    @LoggedInUser() user: SessionUser,
    @Req() req: Request,
  ): Promise<EnqueueResult> {
    return this.queue.enqueue(
      id,
      { userId: user.id, name: user.username },
      sourceFrom(req),
    );
  }

  /**
   * Testversand — ausschliesslich an die eigene Adresse des angemeldeten
   * Kontos, und nur, wenn für sie eine bestätigte Einwilligung vorliegt.
   *
   * Kein Adressfeld. Die Begründung steht in `WarteschlangeService.testversand`
   * und ist die wichtigste dieses Moduls: Ein Testversand an eine frei
   * wählbare Adresse wäre genau der Weg, R3 „durch Fehlbedienung" zu umgehen.
   */
  @Post('templates/:id/test-send')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async testSend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() _dto: BroadcastSendDto,
    @LoggedInUser() user: SessionUser,
    @Req() req: Request,
  ): Promise<{ sent: boolean; reason?: string }> {
    return this.queue.testSend(
      id,
      { id: user.id, username: user.username, email: user.email },
      sourceFrom(req),
    );
  }

  /**
   * Stösst den Versandlauf von Hand an.
   *
   * Warum es das gibt: dieselbe Begründung wie beim Zeitplan aus Etappe 2 —
   * ein Vorgang, der nur im Minutentakt eines Cron stattfindet, lässt sich
   * weder prüfen noch nachholen, wenn der Container gerade neu gestartet ist.
   */
  @Post('queue/run')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async run(@Body() _dto: BroadcastSendDto): Promise<SendRunResult> {
    return this.queue.executeSendRun();
  }
}
