import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { SessionUser } from '../auth/session.service';
import { sourceFrom } from '../common/inquiry-source';
import { LoggedInUser } from '../common/decorators/logged-in-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import { SecondFactorGuard } from '../common/guards/second-factor.guard';
import { AddressBlockDto } from './dto/consent.dto';
import type { BlockResult } from './consent.service';
import { ConsentService } from './consent.service';

/**
 * ===========================================================================
 * [W4] DER WIDERSPRUCH, DER NICHT ÜBER DEN LINK KOMMT
 * ===========================================================================
 *
 * Art. 21 Abs. 1 DSGVO und § 7 UWG binden die Wirksamkeit eines Widerspruchs
 * an KEINEN Kanal. Wer anruft, auf eine Mail antwortet oder einen Brief
 * schickt, hat wirksam widersprochen. Bis hierher liess sich das technisch
 * nicht umsetzen: Es gab genau einen Weg zur Sperre, und der führte über einen
 * Token aus einer unserer eigenen Mails.
 *
 * Ebenso wenig liess sich `spam_gemeldet` je setzen — obwohl der Zustand als
 * Pflicht beschrieben ist. Eine Beschwerde erreicht uns über den
 * Postfachanbieter, nie über unseren Link.
 *
 * DIESE ROUTE SPERRT AUSSCHLIESSLICH. Es gibt kein Gegenstück, keinen
 * Parameter „entsperren", keinen Statuswechsel zurück auf `bestaetigt`. Das
 * ist die wichtigste Eigenschaft: Eine Route, die entsperren könnte, wäre der
 * bequemste Weg, R3 zu umgehen — jemand mit Zugriff auf das CRM könnte eine
 * Einwilligung erfinden, die es nie gab. Der Weg zurück bleibt eine neue
 * Eintragung durch die Person selbst über das öffentliche Formular; aus
 * `spam_gemeldet` gibt es auch den nicht.
 *
 * UND SIE SCHWÄCHT AUCH NICHT AB ([K4]). Eine Meldung, die einen SCHWÄCHEREN
 * Zustand nennt als den bestehenden, wird angenommen und protokolliert, aber
 * nicht geschrieben — sonst liesse sich `spam_gemeldet` über den Umweg
 * „abgemeldet" plus neue Formulareintragung in eine anschreibbare Adresse
 * zurückverwandeln. Die Antwort nennt deshalb den GELTENDEN Zustand, nicht den
 * gemeldeten.
 *
 * ZWEITER FAKTOR: Die Sperre ist nicht zurücknehmbar — dasselbe Kriterium wie
 * bei [K3]. Wer sie irrtümlich setzt, kann sie nicht aufheben, und die Person
 * bekommt bis zu einer neuen eigenen Eintragung nichts mehr. Das ist eine
 * Entscheidung, die niemand mit einem erbeuteten Cookie treffen können soll.
 * POST, weil der Guard den Nachweis aus dem Body liest.
 */
@Controller('consent')
@UseGuards(SessionGuard, SecondFactorGuard)
export class ConsentBlockController {
  constructor(private readonly consent: ConsentService) {}

  @Post('block')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async block(
    @Body() dto: AddressBlockDto,
    @LoggedInUser() user: SessionUser,
    @Req() req: Request,
  ): Promise<BlockResult> {
    return this.consent.blockAddress(
      dto.email,
      dto.reason,
      dto.justification,
      { userId: user.id, name: user.username },
      sourceFrom(req),
    );
  }
}
