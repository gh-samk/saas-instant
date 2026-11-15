import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { OutboxController } from './outbox.controller';
import { OutboxService } from './outbox.service';

@Module({
  imports: [AuthModule, MailModule],
  controllers: [OutboxController],
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
