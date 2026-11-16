import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { VaultLockedNoticeService } from './vault-locked-notice.service';
import { EncryptExistingService } from './encrypt-existing.service';
import { VaultController, VaultStatusController } from './vault.controller';
import { VaultService } from './vault.service';

/**
 * Tresor der Feldverschlüsselung. Global, damit Outbox, Health und Zeitplan den
 * Zustand abfragen können, ohne das Modul einzeln zu importieren.
 */
@Global()
@Module({
  imports: [AuthModule, MailModule],
  controllers: [VaultStatusController, VaultController],
  providers: [
    VaultService,
    EncryptExistingService,
    VaultLockedNoticeService,
  ],
  exports: [VaultService, EncryptExistingService],
})
export class VaultModule {}
