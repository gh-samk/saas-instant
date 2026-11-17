import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CoolifyModule } from '../coolify/coolify.module';
import { CompanyModule } from '../companies/company.module';
import { MailModule } from '../mail/mail.module';
import { PurgeService } from './purge.service';
import { ReconciliationService } from './reconciliation.service';
import { InvitationSendService } from './invitation-send.service';
import { SetupStatusService } from './setup-status.service';
import {
  HEALTH_CHECK,
  InstanceProvisioningService,
  WAIT,
  realHealthCheck,
  realWait,
} from './instance-provisioning.service';
import { InstanceController } from './instance.controller';
import { InstancesController } from './instances.controller';
import { InstanceConfidentialController } from './instance-confidential.controller';
import { InstanceService } from './instance.service';
import {
  METRICS_FETCH,
  MetricsFetchService,
  getViaHttp,
} from './metrics-fetch.service';
import { BackupSettingsModule } from '../backup-settings/backup-settings.module';
import { BackupController } from './backup.controller';
import { BackupPlanService } from './backup-plan.service';
import { InstanceBackupService } from './instance-backup.service';
import { InstanceBackupsController } from './instance-backups.controller';
import { InstanceRestoreService } from './instance-restore.service';
import { InternalBackupPlanController } from './internal-backup-plan.controller';
import { BackupService } from './backup.service';
import { SETUP_STATUS_FETCH, getSetupStatusViaHttp } from './setup-status';

/**
 * Instanzverwaltung (Etappe 3).
 *
 * `AuthModule` wegen des `SessionGuard`; `PrismaModule`, `AuditModule`,
 * `CryptoModule` und `CoolifyModule` sind global. `CoolifyModule` steht
 * trotzdem in den Importen, weil dieses Modul ohne es nicht arbeiten kann —
 * die Abhängigkeit soll an der Stelle stehen, an der sie besteht.
 */
@Module({
  // `MailModule` für den Versand des Einrichtungslinks. Es ist nicht global,
  // also steht es hier — an der Stelle, an der die Abhängigkeit besteht.
  imports: [AuthModule, CoolifyModule, MailModule, BackupSettingsModule, CompanyModule],
  controllers: [
    InstanceController,
    InstancesController,
    BackupController,
    InternalBackupPlanController,
    InstanceBackupsController,
    InstanceConfidentialController,
  ],
  providers: [
    InstanceService,
    InstanceProvisioningService,
    MetricsFetchService,
    ReconciliationService,
    PurgeService,
    BackupService,
    BackupPlanService,
    InstanceBackupService,
    InstanceRestoreService,
    SetupStatusService,
    InvitationSendService,
    // DIE DREI AUSWECHSELBAREN FUNKTIONEN, ausdrücklich verdrahtet.
    //
    // Sie sind der Grund, warum die Anwendung in Etappe 3 zunächst nicht
    // startete ([K6]): Als Konstruktor-Vorgabewerte sahen sie in jedem Test
    // richtig aus, waren für den Injector aber schlicht `Function`. Ein
    // Vorgabewert ist keine Verdrahtung — `app.module.spec.ts` prüft das
    // seither bei jedem Lauf nach.
    { provide: WAIT, useValue: realWait },
    { provide: HEALTH_CHECK, useValue: realHealthCheck },
    { provide: METRICS_FETCH, useValue: getViaHttp },
    // Die vierte: die öffentliche Einrichtungsauskunft der Instanz.
    { provide: SETUP_STATUS_FETCH, useValue: getSetupStatusViaHttp },
  ],
  exports: [InstanceService, ReconciliationService, MetricsFetchService],
})
export class InstanceModule {}
