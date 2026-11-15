import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditController } from './audit.controller';

/**
 * Die LESESEITE des Audit-Logs.
 *
 * Sie steht bewusst NICHT im globalen `AuditModule`: Der Controller braucht
 * den `SitzungGuard`, der das `AuthModule` braucht, das wiederum den
 * `AuditService` braucht. Ein globales Modul, das `AuthModule` importiert,
 * schlösse diesen Ring.
 *
 * `AuditService` kommt aus dem globalen Modul und muss hier nicht noch einmal
 * bereitgestellt werden.
 */
@Module({
  imports: [AuthModule],
  controllers: [AuditController],
})
export class SecurityLogModule {}
