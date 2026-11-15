import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { InvoiceDocumentService } from './document.service';
import { IssuerConfigService } from './document/issuer.config';
import {
  INVOICE_RENDERER,
  InvoiceRendererHttpClient,
  InvoiceRendererNotConfiguredClient,
} from './document/invoice-renderer.client';
import { PricingConfigService } from './pricing.config';
import { PricingService } from './pricing.service';
import { InvoiceCompletionController } from './invoice-completion.controller';
import { InvoicePaymentController } from './invoice-payment.controller';
import { InvoiceController } from './invoice.controller';
import { InvoiceService } from './invoice.service';
import { InvoiceSendService } from './send.service';
import { PaymentService } from './payment.service';
import { GobdExportController } from './gobd-export.controller';
import { GobdExportService } from './gobd-export.service';
import { InvoiceHistoryService } from './invoice-history.service';
import { IntegrityService } from './integrity.service';

/**
 * Rechnungen (Etappe 4).
 *
 * `AuthModule` wegen `SessionGuard` und `SecondFactorGuard`, `MailModule` für
 * den Versand. `PrismaModule` und `AuditModule` sind global.
 *
 * DIE WAHL DES RECHNUNGSDIENSTES fällt hier, nach demselben Muster wie bei
 * Coolify: Wer `RECHNUNGSDIENST_URL` ausdrücklich leer setzt, bekommt einen
 * Ersatz, der bei jedem Aufruf einen fachlichen Fehler wirft. Rechnungen
 * lassen sich damit weiterhin anlegen, festschreiben und stornieren — nur das
 * PDF fehlt, und das sagt die Antwort auch. Eine stille Wirkungslosigkeit gibt
 * es an keiner Stelle.
 */
@Module({
  imports: [AuthModule, MailModule],
  controllers: [
    InvoiceController,
    // [K3]: Alles Unumkehrbare — festschreiben, stornieren, versenden,
    // erinnern — liegt hinter dem zweiten Faktor.
    InvoiceCompletionController,
    InvoicePaymentController,
    // GoBD-Pruefer-Export: Session + zweiter Faktor.
    GobdExportController,
  ],
  providers: [
    PricingConfigService,
    PricingService,
    IssuerConfigService,
    InvoiceService,
    PaymentService,
    InvoiceDocumentService,
    InvoiceSendService,
    // GoBD: Integritaetslauf (nachts, @Cron), Verlauf, Pruefer-Export.
    IntegrityService,
    InvoiceHistoryService,
    GobdExportService,
    {
      provide: INVOICE_RENDERER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const value = config.get<string>('RECHNUNGSDIENST_URL');
        // Nur ein AUSDRÜCKLICH leerer Wert schaltet ab. Eine nicht gesetzte
        // Variable bedeutet „Vorgabe im Compose-Netz benutzen" — sonst wäre
        // das Modul nach dem ersten Ausrollen ohne Zutun stumm.
        return value !== undefined && value.trim() === ''
          ? new InvoiceRendererNotConfiguredClient()
          : new InvoiceRendererHttpClient(config);
      },
    },
  ],
  // PreisKonfigService nach aussen, weil die Aufgabenliste gegen dieselbe
  // Preistafel prueft, aus der die Rechnungen entstehen.
  exports: [InvoiceService, PricingService, PricingConfigService],
})
export class InvoiceModule {}
