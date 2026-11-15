import { Module } from '@nestjs/common';
import { ManifestService } from '../manifest/manifest.service';
import { applyMailBrand } from './mail-brand';
import { MailService } from './mail.service';

@Module({
  providers: [
    MailService,
    {
      // Trägt Produktname, Anbieterzeilen und Absender aus dem Manifest ein,
      // bevor der erste Versand läuft.
      provide: 'MAIL_BRAND_TAKEN_OVER',
      useFactory: (manifest: ManifestService): true => {
        applyMailBrand(manifest);
        return true;
      },
      inject: [ManifestService],
    },
  ],
  exports: [MailService],
})
export class MailModule {}
