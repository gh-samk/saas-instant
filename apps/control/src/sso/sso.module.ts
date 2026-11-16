import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module';
import { SsoController } from './sso.controller';
import { SsoService } from './sso.service';

/**
 * Anmeldung über das Portal (Client-Seite). Hängt am `AuthModule`: die
 * Sitzung selbst (JWT, Cookie, Guards) bleibt dort; hier entsteht nur der Weg
 * hinein.
 */
@Module({
  imports: [AuthModule, JwtModule.register({})],
  controllers: [SsoController],
  providers: [SsoService],
  exports: [SsoService],
})
export class SsoModule {}
