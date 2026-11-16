import { Body, Controller, Get, HttpCode, Put, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { SessionUser } from '../auth/session.service';
import { LoggedInUser } from '../common/decorators/logged-in-user.decorator';
import { WithoutSecondFactor } from '../common/decorators/without-second-factor.decorator';
import { SecondFactorGuard } from '../common/guards/second-factor.guard';
import { SessionGuard } from '../common/guards/session.guard';
import { RequireAdmin } from '../common/decorators/require-role.decorator';
import { RoleGuard } from '../common/guards/role.guard';
import { sourceFrom } from '../common/inquiry-source';
import { PricesUpdateDto } from './dto/prices.dto';
import { PriceSettingsService } from './price-settings.service';
import type { PricesResponse } from './price-settings.service';

/**
 * Einstellungen → Preise.
 *
 * Lesen hängt nur an der Sitzung, SPEICHERN am zweiten Faktor: Preise gehen in
 * jede künftige Rechnung ein, und eine Änderung ist (anders als ein Schalter)
 * eine Geldfolge. Alte, festgeschriebene Rechnungen bleiben unberührt (R2).
 */
@Controller('settings/prices')
@UseGuards(SessionGuard, RoleGuard, SecondFactorGuard)
export class PricesController {
  constructor(private readonly prices: PriceSettingsService) {}

  @Get()
  @WithoutSecondFactor(
    'Rein lesend: die Preisliste enthält keine Geheimnisse und keinen Personenbezug.',
  )
  async get(): Promise<PricesResponse> {
    return this.prices.get();
  }

  @RequireAdmin()
  @Put()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async update(
    @LoggedInUser() user: SessionUser,
    @Body() dto: PricesUpdateDto,
    @Req() req: Request,
  ): Promise<PricesResponse> {
    return this.prices.update(dto, user, sourceFrom(req));
  }
}
