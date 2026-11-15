import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SessionGuard } from '../common/guards/session.guard';
import { OutboxService } from './outbox.service';
import type { OutboxSituation } from './outbox.types';

/**
 * „Jetzt erneut prüfen" aus dem Dashboard.
 *
 * Löst eine Probe aus (verbinden, TLS, anmelden — KEINE Mail) und gibt den
 * neuen Stand zurück. Gelesen wird der Stand nicht hier, sondern mit den
 * Aufgaben: Eine Störung ist eine Aufgabe, keine eigene Anzeige.
 *
 * Eng begrenzt, weil jeder Aufruf eine Anmeldung am Mailserver ist — und
 * gehäufte Fehlanmeldungen dort eine Sperre auslösen können.
 */
@Controller('outbox')
@UseGuards(SessionGuard)
export class OutboxController {
  constructor(private readonly outbox: OutboxService) {}

  @Post('check')
  @HttpCode(200)
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  async check(): Promise<OutboxSituation[]> {
    return this.outbox.checkAll();
  }
}
