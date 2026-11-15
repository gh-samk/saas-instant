import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { IntakePublicController } from './intake-public.controller';
import { MailModule } from '../mail/mail.module';
import { IntakeService } from './intake.service';
import {
  IntakeManagementService,
  IntakeSendService,
} from './intake-send.service';
import { IntakeAccessService } from './intake-access.service';
import { IssuerConfigService } from '../invoices/document/issuer.config';

/**
 * Das Aufnahmeformular der Pilotphase.
 *
 * KEIN `AuthModule`: Der öffentliche Weg hat keine Sitzung. Was die
 * Verwaltung braucht — Link erzeugen, Zustand lesen —, hängt am
 * `CompanyConfidentialController` und damit hinter dem zweiten Faktor;
 * der Dienst wird dafür exportiert.
 */
@Module({
  imports: [AuditModule, MailModule],
  controllers: [IntakePublicController],
  // `IssuerConfigService` ist ein reiner Konfigurationsleser ohne
  // Zustand. Der Mandatstext braucht Glaeubigername und Glaeubiger-ID — und
  // zwar DIESELBEN wie die Rechnung, sonst stuende auf dem Mandat ein anderer
  // Glaeubiger als auf dem Beleg.
  providers: [
    IntakeService,
    IntakeSendService,
    IntakeManagementService,
    IntakeAccessService,
    IssuerConfigService,
  ],
  exports: [
    IntakeService,
    IntakeSendService,
    IntakeManagementService,
    IntakeAccessService,
  ],
})
export class IntakeModule {}
