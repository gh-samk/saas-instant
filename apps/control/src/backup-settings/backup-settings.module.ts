import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BackupAgentClient } from './backup-agent.client';
import { BackupSettingsController } from './backup-settings.controller';
import { BackupSettingsService } from './backup-settings.service';

/**
 * Sicherungsziel konfigurieren und den Sicherungs-Agent ansprechen.
 *
 * Die Verwaltung führt weder Dump noch Restore aus und hält keine
 * Speicher-Zugangsdaten; sie konfiguriert und STÖSST AN. `PrismaModule`,
 * `AuditModule` und `ConfigModule` sind global.
 */
@Module({
  imports: [AuthModule],
  controllers: [BackupSettingsController],
  providers: [BackupSettingsService, BackupAgentClient],
  exports: [BackupAgentClient],
})
export class BackupSettingsModule {}
