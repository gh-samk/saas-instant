import {
  Body,
  Controller,
  HttpCode,
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
import { SessionGuard } from '../common/guards/session.guard';
import { SecondFactorGuard } from '../common/guards/second-factor.guard';
import { EvidenceAlways } from '../common/decorators/evidence-always.decorator';
import { EvidenceDto } from '../companies/dto/company.dto';
import { asActor } from '../companies/company.controller';
import {
  InvitationSendService,
  type InvitationLinkSend,
} from './invitation-send.service';
import { InstanceService } from './instance.service';

/**
 * DER EINRICHTUNGSLINK EINER KUNDENINSTANZ — hinter dem `SecondFactorGuard`.
 *
 * WARUM ES DIESEN CONTROLLER GIBT ([A.7]): Der Link trug bisher das
 * Einrichtungsgeheimnis der Kundeninstanz und stand fertig zusammengesetzt in
 * der Antwort von `GET :id/instanz` — hinter blosser Sitzung, ohne zweiten
 * Faktor, ohne eigene Drosselung, ohne Eintrag im Nachweis. Ein erbeutetes
 * Sitzungs-Cookie (30 Tage, selbsterneuernd) hätte genügt, um bei JEDER noch
 * nicht eingerichteten Kundeninstanz Administrator zu werden. Das ist genau der
 * Schaden, gegen den das Frischefenster des `SecondFactorGuard` gebaut ist.
 *
 * Das Muster ist das des `OrganisationVertraulichController`, und zwar
 * absichtlich bis ins Detail: POST auch fürs blosse Anzeigen, weil der
 * `SecondFactorGuard` den Nachweis aus dem Rumpf liest und ein GET keinen hat;
 * ein eigenes Limit, weil sich ein Nachweis erraten lässt wie ein Passwort;
 * und ein Eintrag im Nachweis, weil schon der Versuch eine Auskunft ist.
 *
 * `GET :id/instanz` sagt weiterhin, OB es einen Link zu holen gäbe
 * (`invitationOpen`) — das ist keine Auskunft, die jemandem nützt, und die
 * Oberfläche braucht sie, um den Knopf überhaupt anzubieten.
 */
@Controller('companies')
@UseGuards(SessionGuard, SecondFactorGuard)
export class InstanceConfidentialController {
  constructor(
    private readonly instances: InstanceService,
    private readonly sender: InvitationSendService,
  ) {}

  @Post(':id/instance/invitation-link/reveal')
  @HttpCode(200)
  @EvidenceAlways(
    'Der Einrichtungslink macht zum Administrator einer FREMDEN Installation. ' +
      'Das Frischefenster der Zahlungsdaten reicht dafür nicht: Auch wer sich ' +
      'vor fünf Minuten angemeldet hat — womöglich nur per Merk-Gerät und ' +
      'Passwort — weist sich hier noch einmal aus.',
  )
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async invitationLink(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Body() _dto: EvidenceDto,
    @Req() req: Request,
  ): Promise<{ invitationLink: string | null }> {
    return this.instances.invitationLink(
      id,
      asActor(user),
      sourceFrom(req),
    );
  }

  /**
   * Schickt den Einrichtungslink an die hinterlegte Ansprechpartnerin.
   *
   * DERSELBE SCHUTZ WIE BEIM ANZEIGEN, und zwar ausdrücklich — obwohl der
   * Aufnahmelink ohne zweiten Faktor verschickt werden darf. Der Unterschied:
   * Die Ansprechpartnerin lässt sich mit der blossen Sitzung ändern. Ohne
   * Nachweis hiesse das: Adresse umstellen, Link an sich selbst schicken,
   * Administrator einer fremden Installation werden. Der Aufnahmelink führt
   * zu einem Formular, dieser hier zur ganzen Instanz.
   */
  @Post(':id/instance/invitation-link/send')
  @HttpCode(200)
  @EvidenceAlways(
    'Die Mail trägt denselben Link wie die Anzeige. Die Empfängeradresse ist ' +
      'ohne zweiten Faktor änderbar; wer beides mit einem erbeuteten Cookie ' +
      'könnte, lenkte den Zugang zur Kundeninstanz an sich selbst.',
  )
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async invitationLinkSend(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Body() _dto: EvidenceDto,
    @Req() req: Request,
  ): Promise<InvitationLinkSend> {
    return this.sender.send(id, asActor(user), sourceFrom(req));
  }
}
