import { Controller, Get, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AllowWhileLocked } from '../vault/allow-while-locked.decorator';
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

  @AllowWhileLocked(
    'Liest nur Instance.subdomain und Instance.coolifyApplicationId sowie das ' +
      'Manifest; beides ist unverschlüsselt. Ohne diese Route sicherte der Agent ' +
      'nach einem Neustart nichts, bis jemand entsperrt.',
  )
  @Get()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async get(): Promise<BackupPlanResponse> {
    return this.plan.response();
  }
}
