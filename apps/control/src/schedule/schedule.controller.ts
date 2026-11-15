import { Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { SessionUser } from '../auth/session.service';
import { sourceFrom } from '../common/inquiry-source';
import { LoggedInUser } from '../common/decorators/logged-in-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import type { ScheduleResult } from './schedule.service';
import { ScheduleService } from './schedule.service';

/**
 * Auslösen des Zeitplans von Hand.
 *
 * Warum es das gibt: Ein Vorgang, der nur nachts um drei stattfindet, lässt
 * sich weder prüfen noch nachholen. Fiel der Container in der Nacht aus, wäre
 * die Betreiberin sonst bis zum nächsten Tag ohne Weg.
 *
 * Der Lauf läuft auch dann, wenn `CONTROL_SCHEDULE_ENABLED=nein` die nächtliche
 * Ausführung abschaltet — das Abschalten betrifft den Automatismus, nicht die
 * ausdrückliche Handlung eines angemeldeten Menschen.
 *
 * Schutz: Sitzung und CSRF. Der Lauf ändert keinen Zugang und keine Geldfolge
 * (R5), deshalb kein zweiter Faktor.
 */
@Controller('schedule')
@UseGuards(SessionGuard)
export class ScheduleController {
  constructor(private readonly schedule: ScheduleService) {}

  @Post('run')
  @HttpCode(200)
  // Der Lauf geht über den ganzen Bestand; im Minutentakt braucht ihn niemand.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async run(
    @LoggedInUser() user: SessionUser,
    @Req() req: Request,
  ): Promise<ScheduleResult> {
    return this.schedule.runFrom(
      { actor: user.username, userId: user.id },
      sourceFrom(req),
    );
  }
}
