import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConsentModule } from '../consent/consent.module';
import { BroadcastSendController } from './broadcast-send.controller';
import { BroadcastController } from './broadcast.controller';
import { TemplateService } from './template.service';
import { QueueService } from './queue.service';
import { MarketingMailService } from './marketing-mail.service';

/**
 * Rundmail (Etappe 5) — der WERBLICHE Kanal.
 *
 * `AuthModule` wegen `SitzungGuard` und `ZweitfaktorGuard`,
 * `EinwilligungModule` wegen des Tors und der Abmeldelinks. `PrismaModule` und
 * `AuditModule` sind global.
 *
 * `MailModule` fehlt hier ABSICHTLICH: Dieser Kanal verschickt über
 * `WerbeMailService` und hat auf den Transaktionsversand keinen Zugriff. Die
 * Trennung aus R3 ist damit auch eine Trennung der Abhängigkeiten — ein
 * späterer Umbau, der den `MailService` hier benutzen wollte, müsste den
 * Import zuerst hinzufügen und fiele im Review auf.
 *
 * HIER STAND `AusstellerKonfigService` ein zweites Mal in der Providerliste
 * — gebraucht für die Anbieterkennung in der Fusszeile der Rundmail ([A.33]).
 * Die Kennung steht jetzt im Rahmen und gilt für BEIDE Kanäle; damit braucht
 * dieses Modul den Leser nicht mehr. Das alte Argument („zwei Fassungen
 * derselben Angaben liefen auseinander") ist damit nicht widerlegt, sondern
 * eine Ebene konsequenter zu Ende geführt: Es gibt sie jetzt nur noch einmal.
 */
@Module({
  imports: [AuthModule, ConsentModule],
  controllers: [BroadcastController, BroadcastSendController],
  providers: [
    TemplateService,
    MarketingMailService,
    QueueService,
  ],
  exports: [QueueService, TemplateService],
})
export class BroadcastModule {}
