import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { SessionUser } from '../auth/session.service';
import { sourceFrom } from '../common/inquiry-source';
import { LoggedInUser } from '../common/decorators/logged-in-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import { RequireAdmin } from '../common/decorators/require-role.decorator';
import { RoleGuard } from '../common/guards/role.guard';
import { FlagSetDto } from './dto/flag-set.dto';
import type { FeatureFlagEntry } from './feature-flag.service';
import { FeatureFlagService } from './feature-flag.service';

/**
 * Die Funktionsschalter in den Einstellungen (Reiter „Funktionen").
 *
 * Schutz: Sitzung. Kein zweiter Faktor — ein Schalter lässt sich jederzeit
 * zurückstellen, hat keine Geldfolge, berührt keinen Zugang und steht mit
 * vorher/nachher im Audit-Log (Begründung in `controller-schutz.spec.ts`).
 */
@Controller('feature-flags')
@UseGuards(SessionGuard, RoleGuard)
export class FeatureFlagController {
  constructor(private readonly flag: FeatureFlagService) {}

  @Get()
  async all(): Promise<FeatureFlagEntry[]> {
    return this.flag.all();
  }

  @RequireAdmin()
  @Put(':key')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async set(
    @Param('key') key: string,
    @Body() dto: FlagSetDto,
    @LoggedInUser() user: SessionUser,
    @Req() req: Request,
  ): Promise<FeatureFlagEntry> {
    return this.flag.set(key, dto.enabled, user, sourceFrom(req));
  }
}
