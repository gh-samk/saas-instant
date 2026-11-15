import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { InquiryKeyGuard } from './inquiry-key.guard';
import { PublicController } from './public.controller';
import { PublicService } from './public.service';
import { ConsentModule } from '../consent/consent.module';

@Module({
  imports: [MailModule, ConsentModule],
  controllers: [PublicController],
  providers: [PublicService, InquiryKeyGuard],
})
export class PublicModule {}
