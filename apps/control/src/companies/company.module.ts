import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CompanyConfidentialController } from './company-confidential.controller';
import { CompanyController } from './company.controller';
import { IntakeModule } from '../intake/intake.module';
import { InvoiceModule } from '../invoices/invoice.module';
import { CompanyService } from './company.service';

/**
 * Organisationen (Etappe 2).
 *
 * `AuthModule` wird importiert, weil der `SessionGuard` den `SitzungService`
 * braucht; `PrismaModule` und `AuditModule` sind global.
 */
@Module({
  // `IntakeModule` fuer den automatischen Versand des Aufnahmelinks beim
  // Statuswechsel auf `pilot_approved`. Die Richtung ist bewusst so herum:
  // Die Aufnahme kennt die Organisation nicht, die Organisation loest den
  // Versand aus.
  imports: [AuthModule, IntakeModule, InvoiceModule],
  controllers: [CompanyController, CompanyConfidentialController],
  providers: [CompanyService],
  exports: [CompanyService],
})
export class CompanyModule {}
