import { Body, Controller, Get, Header, HttpCode, Post, Put, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { SessionUser } from '../auth/session.service';
import { LoggedInUser } from '../common/decorators/logged-in-user.decorator';
import { WithoutSecondFactor } from '../common/decorators/without-second-factor.decorator';
import { SecondFactorGuard } from '../common/guards/second-factor.guard';
import { SessionGuard } from '../common/guards/session.guard';
import { sourceFrom } from '../common/inquiry-source';
import {
  BackupSettingsUpdateDto,
  SecondFactorEvidenceDto,
} from './dto/backup-settings.dto';
import {
  BackupSettingsService,
  type BackupSettingsResponse,
  type BackupTestResponse,
} from './backup-settings.service';

/**
 * Einstellungen → Sicherung.
 *
 * Lesen hängt nur an der Sitzung, SCHREIBEN und TESTEN am zweiten Faktor.
 * Geheimnisse sind write-only (siehe `BackupSettingsService`).
 */
@Controller('settings/backup')
@UseGuards(SessionGuard, SecondFactorGuard)
export class BackupSettingsController {
  constructor(private readonly settings: BackupSettingsService) {}

  @Get()
  @WithoutSecondFactor(
    'Rein lesend: nur Metadaten des Sicherungsziels und der Zustand des Agents, ' +
      'keine Zugangsdaten.',
  )
  async get(): Promise<BackupSettingsResponse> {
    return this.settings.get();
  }

  // Die Antwort kann EINMALIG den privaten age-Schlüssel tragen: nie zwischenspeichern.
  @Put()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async update(
    @LoggedInUser() user: SessionUser,
    @Body() dto: BackupSettingsUpdateDto,
    @Req() req: Request,
  ): Promise<BackupSettingsResponse> {
    return this.settings.update(dto, user, sourceFrom(req));
  }

  @Post('test')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async test(
    @LoggedInUser() user: SessionUser,
    @Body() _evidence: SecondFactorEvidenceDto,
    @Req() req: Request,
  ): Promise<BackupTestResponse> {
    return this.settings.test(user, sourceFrom(req));
  }
}
