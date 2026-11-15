import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { SessionUser } from '../auth/session.service';
import { LoggedInUser } from '../common/decorators/logged-in-user.decorator';
import { WithoutSecondFactor } from '../common/decorators/without-second-factor.decorator';
import { SecondFactorGuard } from '../common/guards/second-factor.guard';
import { SessionGuard } from '../common/guards/session.guard';
import { sourceFrom } from '../common/inquiry-source';
import { EvidenceOnlyDto, RestoreStartDto } from './dto/instance-backup.dto';
import {
  InstanceBackupService,
  type InstanceBackupList,
  type JobView,
} from './instance-backup.service';
import { InstanceRestoreService, type RestoreView } from './instance-restore.service';

/**
 * Sicherungen und Wiederherstellungen einer Instanz (`/api/instances/:id/…`).
 *
 * Lesen hängt nur an der Sitzung; ALLES SCHREIBENDE (jetzt sichern, prüfen,
 * wiederherstellen, übernehmen) zusätzlich am zweiten Faktor. Jede Handlung
 * steht im Audit-Log. Die Verwaltung stößt nur an: Dump und Einspielen
 * macht der Sicherungs-Agent. Es gibt hier keine Löschroute (R1/R4); die
 * Übernahme STOPPT die alte Instanz.
 */
@Controller('instances/:id')
@UseGuards(SessionGuard, SecondFactorGuard)
export class InstanceBackupsController {
  constructor(
    private readonly backups: InstanceBackupService,
    private readonly recoveries: InstanceRestoreService,
  ) {}

  @Get('backups')
  @WithoutSecondFactor('Rein lesend: Datum, Größe und Prüfsumme der Sicherungen, keine Zugangsdaten.')
  async list(
    @Param('id') id: string,
    @Query('includeAgent') includeAgent?: string,
  ): Promise<InstanceBackupList> {
    return this.backups.list(id, includeAgent === 'true' || includeAgent === '1');
  }

  @Post('backups')
  @HttpCode(202)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async trigger(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Body() _evidence: EvidenceOnlyDto,
    @Req() req: Request,
  ): Promise<{ jobId: string }> {
    return this.backups.trigger(id, { userId: user.id, name: user.username }, sourceFrom(req));
  }

  @Get('backups/jobs/:jobId')
  @WithoutSecondFactor('Rein lesend: Stand eines Auftrags beim Agent, ohne Geheimnisse.')
  async job(
    @Param('id') id: string,
    @Param('jobId') jobId: string,
    @Query('backupId') backupId?: string,
  ): Promise<JobView> {
    return this.backups.job(id, jobId, backupId);
  }

  @Post('backups/:backupId/verify')
  @HttpCode(202)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async verify(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Param('backupId') backupId: string,
    @Body() _evidence: EvidenceOnlyDto,
    @Req() req: Request,
  ): Promise<{ jobId: string }> {
    return this.backups.verify(id, backupId, { userId: user.id, name: user.username }, sourceFrom(req));
  }

  @Get('restores')
  @WithoutSecondFactor('Rein lesend: Stand der Wiederherstellungen, Klartext ohne Geheimnisse.')
  async restores(@Param('id') id: string): Promise<RestoreView[]> {
    return this.recoveries.list(id);
  }

  // Der private Schlüssel steckt im Body, nie in der Antwort.
  @Post('restores')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async startRecovery(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Body() dto: RestoreStartDto,
    @Req() req: Request,
  ): Promise<RestoreView> {
    return this.recoveries.start(id, dto, { userId: user.id, name: user.username }, sourceFrom(req));
  }

  @Post('restores/:restoreId/adopt')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async adopt(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Param('restoreId') restoreId: string,
    @Body() _evidence: EvidenceOnlyDto,
    @Req() req: Request,
  ): Promise<RestoreView> {
    return this.recoveries.adopt(id, restoreId, { userId: user.id, name: user.username }, sourceFrom(req));
  }
}
