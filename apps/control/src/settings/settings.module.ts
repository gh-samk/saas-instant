import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InvoiceModule } from '../invoices/invoice.module';
import { PriceSettingsService } from './price-settings.service';
import { PricesController } from './prices.controller';
import { IssuerSettingsController, PublicLogoController } from './issuer.controller';

/**
 * Einstellungen der Verwaltung, die über das eigene Konto hinausgehen
 * (derzeit: Preise). `PrismaModule` und `AuditModule` sind global.
 */
@Module({
  imports: [AuthModule, InvoiceModule],
  controllers: [PricesController, IssuerSettingsController, PublicLogoController],
  providers: [PriceSettingsService],
})
export class SettingsModule {}
