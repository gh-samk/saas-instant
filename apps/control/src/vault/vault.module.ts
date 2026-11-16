import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EncryptExistingService } from './encrypt-existing.service';
import { VaultController, VaultStatusController } from './vault.controller';
import { VaultService } from './vault.service';

/**
 * Tresor der Feldverschlüsselung. Global, damit Outbox, Health und Zeitplan den
 * Zustand abfragen können, ohne das Modul einzeln zu importieren.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [VaultStatusController, VaultController],
  providers: [
    VaultService,
    EncryptExistingService,
  ],
  exports: [VaultService, EncryptExistingService],
})
export class VaultModule {}
