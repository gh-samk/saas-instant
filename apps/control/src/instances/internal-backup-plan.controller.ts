import { Controller, Get, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { BackupKeyGuard } from './backup-key.guard';
import { BackupPlanService, type BackupPlanResponse } from './backup-plan.service';

/**
 * `GET /api/internal/backup-plan` — `{ retentionYears, instances }` für den Sicherungs-Agent.
 *
 * Wie der Meldeweg hängt die Route am Schlüssel im Header (`x-backup-key`,
 * `BackupKeyGuard`; ohne gesetzten Schlüssel gibt es sie nicht: 404). Sie
 * liest nur und liefert Namen — keine Zugangsdaten, keine Tokens.
 */
@Controller('internal/backup-plan')
@UseGuards(BackupKeyGuard)
export class InternalBackupPlanController {
  constructor(private readonly plan: BackupPlanService) {}

  @Get()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async get(): Promise<BackupPlanResponse> {
    return this.plan.response();
  }
}
