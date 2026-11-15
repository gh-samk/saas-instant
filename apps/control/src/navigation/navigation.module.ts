import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { AuthModule } from '../auth/auth.module';
import { NavigationController } from './navigation.controller';
import { NavigationService } from './navigation.service';

/**
 * Die Zähler der Seitenleiste.
 *
 * Er hängt am `AufgabenModule`, weil die dringende Zahl aus derselben Quelle
 * kommen soll wie die Liste — nicht aus einer zweiten, eigenen Rechnung.
 */
@Module({
  imports: [AuthModule, TasksModule],
  controllers: [NavigationController],
  providers: [NavigationService],
})
export class NavigationModule {}
