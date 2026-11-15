import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FeatureFlagController } from './feature-flag.controller';
import { FeatureFlagService } from './feature-flag.service';
import { FlagPublicController } from './flag-public.controller';

/**
 * Betriebsschalter für alle Kundeninstanzen. Das Audit-Log kommt aus dem
 * globalen `AuditModule`, der `SessionGuard` aus dem `AuthModule`.
 */
@Module({
  imports: [AuthModule],
  controllers: [FeatureFlagController, FlagPublicController],
  providers: [FeatureFlagService],
})
export class FeatureFlagModule {}
