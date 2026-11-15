import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AuditModule } from '../audit/audit.module';
import { ManifestModule } from '../manifest/manifest.module';
import { CryptoModule } from '../crypto/crypto.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { SecondFactorGuard } from '../common/guards/second-factor.guard';
import { SessionGuard } from '../common/guards/session.guard';
import { InvoiceCompletionController } from './invoice-completion.controller';
import { InvoicePaymentController } from './invoice-payment.controller';
import { InvoiceController } from './invoice.controller';
import { InvoiceModule } from './invoice.module';
import { InvoiceService } from './invoice.service';
import { InvoiceDocumentService } from './document.service';
import { InvoiceSendService } from './send.service';
import { PaymentService } from './payment.service';
import { PricingService } from './pricing.service';
import {
  INVOICE_RENDERER,
  InvoiceRendererNotConfiguredClient,
  type InvoiceRenderer,
} from './document/invoice-renderer.client';

/**
 * DAS MODUL LÄSST SICH ÜBERHAUPT ZUSAMMENBAUEN.
 *
 * Ein Verdrahtungsfehler zeigt sich in NestJS erst beim Hochfahren — nicht beim
 * Übersetzen und nicht in einem Test, der den Dienst von Hand mit `new` baut.
 * Genau so ist in Etappe 2 der Guard an den vertraulichen Vorgängen einmal
 * durchgerutscht: Alle Tests waren grün, und der Container startete nicht.
 *
 * Deshalb wird hier das ECHTE Modul gebaut, mit den echten Guards. Der
 * `PrismaService` wird ersetzt — er würde sonst beim `onModuleInit` eine
 * Datenbankverbindung aufbauen, und diese Suite läuft ohne Datenbank.
 */

describe('InvoiceModule lässt sich verdrahten', () => {
  async function build(environment: Record<string, string> = {}) {
    const old = { ...process.env };
    Object.assign(process.env, environment);
    try {
      const module = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
          PrismaModule,
          AuditModule,
          CryptoModule,
          ManifestModule,
          InvoiceModule,
        ],
      })
        .overrideProvider(PrismaService)
        .useValue({})
        .compile();
      return module;
    } finally {
      process.env = old;
    }
  }

  it('löst den Abschluss-Controller samt seiner Dienste auf ([K3])', async () => {
    const module = await build({ CONTROL_CONFIG_KEY: 'x'.repeat(40) });
    // Ein Verdrahtungsfehler an genau diesem Controller wäre besonders
    // heimtückisch: Die Anwendung startete nicht, und bis dahin sähe alles
    // grün aus.
    expect(module.get(InvoiceCompletionController)).toBeDefined();
    await module.close();
  });

  it('löst beide Controller samt ihrer Dienste auf', async () => {
    const module = await build({ CONTROL_CONFIG_KEY: 'x'.repeat(40) });

    expect(module.get(InvoiceController)).toBeInstanceOf(InvoiceController);
    expect(module.get(InvoicePaymentController)).toBeInstanceOf(
      InvoicePaymentController,
    );
    expect(module.get(InvoiceService)).toBeInstanceOf(InvoiceService);
    expect(module.get(PaymentService)).toBeInstanceOf(PaymentService);
    expect(module.get(PricingService)).toBeInstanceOf(PricingService);
    expect(module.get(InvoiceDocumentService)).toBeInstanceOf(
      InvoiceDocumentService,
    );
    expect(module.get(InvoiceSendService)).toBeInstanceOf(
      InvoiceSendService,
    );
    await module.close();
  });

  /**
   * DER GUARD BRAUCHT DEN `ZugangService` AUS DEM `AuthModule`.
   *
   * Fehlte der Import, ließe sich das Modul zwar übersetzen, aber nicht
   * hochfahren — und die Route stünde am Ende ungeschützt oder gar nicht da.
   */
  it('löst SessionGuard und SecondFactorGuard auf', async () => {
    const module = await build({ CONTROL_CONFIG_KEY: 'x'.repeat(40) });
    expect(module.get(SessionGuard, { strict: false })).toBeInstanceOf(
      SessionGuard,
    );
    expect(module.get(SecondFactorGuard, { strict: false })).toBeInstanceOf(
      SecondFactorGuard,
    );
    await module.close();
  });

  /**
   * EIN AUSDRÜCKLICH LEERES `RECHNUNGSDIENST_URL` SCHALTET DIE PDF-ERZEUGUNG AB
   * — sichtbar, nicht still.
   */
  it('nimmt bei leerem RECHNUNGSDIENST_URL den Ersatz mit fachlichem Fehler', async () => {
    const module = await build({
      CONTROL_CONFIG_KEY: 'x'.repeat(40),
      RECHNUNGSDIENST_URL: '',
    });
    const renderer = module.get<InvoiceRenderer>(INVOICE_RENDERER);
    expect(renderer).toBeInstanceOf(InvoiceRendererNotConfiguredClient);
    expect(renderer.isConfigured()).toBe(false);
    await expect(renderer.create('<html/>', '<xml/>')).rejects.toThrow(
      /RECHNUNGSDIENST_URL/,
    );
    await module.close();
  });
});
