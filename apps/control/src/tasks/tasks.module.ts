import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OutboxModule } from '../outbox/outbox.module';
import { InvoiceModule } from '../invoices/invoice.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  // RechnungModule wegen `PricingConfigService`: Die Aufgabe „Stufe pruefen"
  // vergleicht gegen die GELTENDE Preistafel. Sie aus den Vorgaben zu raten
  // waere eine Aussage ueber Preise, die niemand vereinbart hat.
  imports: [AuthModule, InvoiceModule, OutboxModule],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
