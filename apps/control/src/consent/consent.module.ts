import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { InquiryKeyGuard } from '../public/inquiry-key.guard';
import { ConsentCleanupService } from './cleanup.service';
import { ConsentSubscriptionController } from './consent-subscription.controller';
import { ConsentPublicController } from './consent-public.controller';
import { ConsentBlockController } from './consent-block.controller';
import { ConsentService } from './consent.service';

/**
 * Einwilligung und Double-Opt-in (Etappe 5).
 *
 * `MailModule` für die Bestätigungsmail — sie ist eine TRANSAKTIONSMAIL und
 * geht deshalb über den transaktionalen Kanal (Begründung an
 * `MailService.sendeEinwilligungsBestaetigung`).
 *
 * Der `AnfrageSchluesselGuard` steht hier ein zweites Mal in der
 * Providerliste; er gehört auch zum `OeffentlichModule`. Das ist gewollt:
 * Beide öffentlichen Schreibwege werden von demselben nginx mit demselben
 * Schlüssel bedient, und eine zweite Fassung der Prüfung wäre eine zweite
 * Stelle, an der sie abweichen kann — geteilt wird die Klasse, nicht eine
 * Instanz.
 */
@Module({
  // `AuthModule` wegen `SitzungGuard` und `ZweitfaktorGuard` am
  // Sperr-Controller ([W4]).
  imports: [AuthModule, MailModule],
  controllers: [
    ConsentSubscriptionController,
    ConsentPublicController,
    ConsentBlockController,
  ],
  providers: [
    ConsentService,
    ConsentCleanupService,
    InquiryKeyGuard,
  ],
  exports: [ConsentService, ConsentCleanupService],
})
export class ConsentModule {}
