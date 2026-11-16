import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccountsModule } from './accounts/accounts.module';
import { AdminController } from './admin/admin.controller';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CleanupService } from './cleanup.service';
import { CsrfGuard, RateLimitGuard } from './common/guards';
import { RateLimiter } from './common/rate-limiter';
import { CONFIG, loadConfig } from './config';
import { HealthController } from './health.controller';
import { KeysModule } from './keys/keys.module';
import { MeController } from './me/me.controller';
import { OidcModule } from './oidc/oidc.module';
import { PrismaService } from './prisma.service';
import { SessionsModule } from './sessions/sessions.module';
import { Global } from '@nestjs/common';

@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    PrismaService,
    RateLimiter,
    CleanupService,
  ],
  exports: [CONFIG, PrismaService, RateLimiter],
})
export class CoreModule {}

@Module({
  imports: [CoreModule, AuditModule, SessionsModule, KeysModule, AccountsModule, AuthModule, OidcModule],
  controllers: [HealthController, MeController, AdminController],
  providers: [
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule {}
