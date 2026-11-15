import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
// Die ECHTE Absender-IP trotz der längeren Proxy-Kette dieses Wegs –
// siehe `herkunftAusAnfrage`.
import { sourceFromInquiry } from '../common/inquiry-source';
import { WithoutCsrf } from '../common/decorators/without-csrf.decorator';
import { InquiryKeyGuard } from '../public/inquiry-key.guard';
import { ConsentSubscribeDto } from './dto/consent.dto';
import { ConsentService } from './consent.service';

/** Nach aussen sieht JEDER Ausgang gleich aus. */
export interface SubscribeResponse {
  ok: true;
}

const RESPONSE: SubscribeResponse = { ok: true };

/**
 * DAS EIGENE ANMELDEFORMULAR DES NEWSLETTERS.
 *
 * Getrennt vom Anfrageformular (Demo/Pilot) — mit eigenem Endpunkt, eigenem
 * Häkchen, eigenem Formulartext. Die Begründung steht am DTO und ist die
 * Kernaussage des Auftrags zu diesem Punkt.
 *
 * Schutz wie beim Anfrageweg: derselbe Schlüssel im Header
 * (`AnfrageSchluesselGuard`, gesetzt vom nginx der Webseite, nie im Browser),
 * ein eigenes strenges Rate-Limit und der Honeypot. Eine Sitzung gibt es
 * nicht — die Person, die sich einträgt, hat kein Konto und soll keines
 * bekommen.
 *
 * DIE ANTWORT IST IMMER DIESELBE. Ob die Adresse neu, bereits eingetragen,
 * bereits bestätigt oder gesperrt ist, steht nicht darin: sonst liesse sich
 * über das Formular jede Adresse auf Zugehörigkeit prüfen.
 */
@Controller('consent')
@UseGuards(InquiryKeyGuard)
export class ConsentSubscriptionController {
  constructor(private readonly consent: ConsentService) {}

  @WithoutCsrf(
    'Server-zu-Server-Weg wie beim Anfrageformular: das nginx der Webseite ' +
      'proxyt hierher und weist sich mit CONTROL_INQUIRY_KEY aus. Ein ' +
      'Proxy hat kein CSRF-Cookie, und die Route wertet keine Sitzung aus — ' +
      'es gibt also keine fremde Sitzung, die sich missbrauchen liesse.',
  )
  @Post('subscription')
  @HttpCode(200)
  // Strenger als das globale Limit: Über diese Route lässt sich eine fremde
  // Adresse mit Bestätigungsmails belegen. Fünf je Minute und Absender.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async subscription(
    @Body() dto: ConsentSubscribeDto,
    @Req() req: Request,
  ): Promise<SubscribeResponse> {
    await this.consent.subscribe(dto, sourceFromInquiry(req));
    return RESPONSE;
  }
}
