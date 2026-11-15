import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
// Die ECHTE Absender-IP trotz der längeren Proxy-Kette dieses Wegs –
// siehe `herkunftAusAnfrage`.
import { sourceFromInquiry } from '../common/inquiry-source';
import { WithoutCsrf } from '../common/decorators/without-csrf.decorator';
import { InquiryKeyGuard } from './inquiry-key.guard';
import { PublicInquiryDto } from './dto/inquiry.dto';
import type { InquiryResponse } from './public.service';
import { PublicService } from './public.service';

/**
 * DER EINZIGE UNAUTHENTIFIZIERTE SCHREIBWEG DER VERWALTUNG.
 *
 * Kein `SitzungGuard` — es gibt niemanden, der sich anmelden könnte. An seine
 * Stelle treten drei Dinge:
 *
 * 1. `AnfrageSchluesselGuard`: ein Geheimnis im Header, zeitkonstant
 *    verglichen. Es steht in der Umgebung und wird vom nginx der Webseite
 *    gesetzt, niemals im Browser.
 * 2. Ein eigenes, strenges Rate-Limit.
 * 3. Der Honeypot `webseite` im Formular (`OeffentlichService.anfrage`).
 *
 * Die CSRF-Ausnahme ist unvermeidlich und ungefährlich: Der Aufrufer ist ein
 * Server, kein Browser — er hat kein Cookie, mit dem sich ein Double-Submit
 * durchführen ließe. Was CSRF verhindern soll (ein fremdes Formular schickt
 * unter der Sitzung des Opfers eine Anfrage ab), kann hier gar nicht
 * eintreten: die Route wertet keine Sitzung aus. Und einen Header setzt ein
 * fremdes Formular ohnehin nicht.
 */
@Controller('public')
@UseGuards(InquiryKeyGuard)
export class PublicController {
  constructor(private readonly publicService: PublicService) {}

  @WithoutCsrf(
    'Server-zu-Server-Weg: das nginx der Webseite proxyt hierher und weist ' +
      'sich mit CONTROL_INQUIRY_KEY aus. Ein Proxy hat kein ' +
      'CSRF-Cookie, und die Route wertet keine Sitzung aus — es gibt also ' +
      'keine fremde Sitzung, die sich missbrauchen ließe.',
  )
  @Post('inquiry')
  @HttpCode(200)
  // Dasselbe Limit wie an den alten Endpunkten in `apps/api`. Es zählt je
  // Absender-IP; steht CONTROL_TRUST_PROXY richtig, ist das die des
  // Formularbesuchers und nicht die des Proxys.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async inquiry(
    @Body() dto: PublicInquiryDto,
    @Req() req: Request,
  ): Promise<InquiryResponse> {
    return this.publicService.inquiry(dto, sourceFromInquiry(req));
  }
}
