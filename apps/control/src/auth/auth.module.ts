import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { SecondFactorGuard } from '../common/guards/second-factor.guard';
import { MailModule } from '../mail/mail.module';
import { LoginFlowService } from './login-flow.service';
import { LoginService } from './login.service';
import { AuthController } from './auth.controller';
import { EmailLoginCodeService } from './email-login-code.service';
import { DeviceService } from './device.service';
import { EmergencyService } from './emergency.service';
import { PasskeyService } from './passkey.service';
import { SessionService } from './session.service';
import { LockoutService } from './lockout.service';
import { TotpService } from './totp.service';
import { RecoveryCodeService } from './recovery-code.service';
import { AccessController } from './access.controller';
import { AccessService } from './access.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
      }),
    }),
    MailModule,
  ],
  controllers: [AuthController, AccessController],
  providers: [
    LoginFlowService,
    LoginService,
    EmailLoginCodeService,
    DeviceService,
    EmergencyService,
    PasskeyService,
    SessionService,
    LockoutService,
    TotpService,
    RecoveryCodeService,
    AccessService,
    SecondFactorGuard,
  ],
  // `ZweitfaktorGuard` UND `ZugangService` werden mit ausgeführt, weil den
  // Guard seit [W4] auch der `OrganisationConfidentialController` verwendet.
  //
  // BEIDES ist nötig, und das ist kein Versehen: `@UseGuards(ZweitfaktorGuard)`
  // lässt Nest den Guard IM MODUL DES CONTROLLERS erzeugen, nicht hier. Der
  // Export des Guards allein genügt deshalb nicht — ohne `ZugangService` im
  // selben Sichtbereich scheitert die Anwendung beim START mit
  // „can't resolve dependencies of the ZweitfaktorGuard". Aufgefallen ist das
  // nicht im Test, sondern beim Hochfahren: Guards mit Abhängigkeiten prüft
  // kein Unit-Test, der den Guard von Hand baut.
  exports: [
    EmergencyService,
    LockoutService,
    SessionService,
    AccessService,
    SecondFactorGuard,
  ],
})
export class AuthModule {}
