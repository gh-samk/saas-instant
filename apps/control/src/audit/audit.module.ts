import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/**
 * Der SCHREIBENDE Teil des Audit-Logs — global, weil ihn fast jeder Dienst
 * braucht.
 *
 * ER HAT KEINEN CONTROLLER, und das ist keine Auslassung: Ein Controller
 * bräuchte den `SitzungGuard`, der `SitzungGuard` das `AuthModule`, und das
 * `AuthModule` wiederum diesen hier — ein Ring. Die Leseseite steht deshalb
 * im `SicherheitsprotokollModul`, das gewöhnlich importiert wird.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
