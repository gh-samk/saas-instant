import type { Request } from 'express';
import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule as NestScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { inquiryHopsFrom, trackerFor } from './common/inquiry-tracker';
import { buildLogConfig } from './common/log-config';
import { AppController, RobotsController } from './app.controller';
import { AuditModule } from './audit/audit.module';
import { UserModule } from './users/user.module';
import { SecurityLogModule } from './audit/security-log.module';
import { TasksModule } from './tasks/tasks.module';
import { NavigationModule } from './navigation/navigation.module';
import { AuthModule } from './auth/auth.module';
import { SsoModule } from './sso/sso.module';
import { CsrfGuard } from './common/guards/csrf.guard';
import { IntakeModule } from './intake/intake.module';
import { ConsentModule } from './consent/consent.module';
import { CoolifyModule } from './coolify/coolify.module';
import { InstanceModule } from './instances/instance.module';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { RobotsMiddleware } from './common/middleware/robots.middleware';
import { CryptoModule } from './crypto/crypto.module';
import { NoteModule } from './notes/note.module';
import { PublicModule } from './public/public.module';
import { CompanyModule } from './companies/company.module';
import { PrismaModule } from './prisma/prisma.module';
import { InvoiceModule } from './invoices/invoice.module';
import { BroadcastModule } from './broadcast/broadcast.module';
import { ScheduleModule } from './schedule/schedule.module';
import { FeatureFlagModule } from './feature-flags/feature-flag.module';
import { SettingsModule } from './settings/settings.module';
import { IssuerProfileModule } from './settings/issuer-profile.module';
import { BackupSettingsModule } from './backup-settings/backup-settings.module';
import { ManifestModule } from './manifest/manifest.module';
import { InstallationModule } from './installation/installation.module';
import { VaultModule } from './vault/vault.module';
import { VaultLockGuard } from './vault/vault-lock.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Produkt-Manifest (global): Name, Mail, Abrechnung, Provisionierung, UI;
    // liefert außerdem GET /api/public-config.
    ManifestModule,
    // Firmenprofil (global): Rechnungsaussteller, Logo, Akzentfarbe.
    IssuerProfileModule,
    // Bindung an genau eine Software (Slug in der DB, Abweichung = Startabbruch).
    InstallationModule,
    // Globales Basis-Rate-Limit. Die Anmelderouten haben zusätzlich ein
    // strengeres Limit von 5 Versuchen je Minute (@Throttle an der Route).
    //
    // `getTracker` bestimmt, WOGEGEN gezählt wird. Für den öffentlichen
    // Anfrageweg ist das nicht `req.ip`: Dessen Proxy-Kette ist zwei Stationen
    // länger als die der Verwaltungsoberfläche, und `trust proxy` gilt für den
    // ganzen Prozess. Ohne diese Unterscheidung teilen sich alle Besucher der
    // Webseite ein einziges Kontingent, und ein einzelner Rechner legt den
    // Anfragekanal lahm ([W1]). Begründung im Einzelnen: `anfrage-tracker.ts`.
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 100 }],
      getTracker: (req: Record<string, unknown>) =>
        trackerFor(
          req as unknown as Request,
          inquiryHopsFrom(process.env['CONTROL_INQUIRY_TRUST_PROXY']),
          // Der Schluessel muss HIER geprueft werden: Dieser Guard laeuft vor
          // dem AnfrageSchluesselGuard des Controllers.
          process.env['CONTROL_INQUIRY_KEY'],
        ),
    }),
    // Die Konfiguration steht in `common/log-konfig.ts` — dort ist sie
    // pruefbar. Inline war sie es nicht, und genau deshalb blieb der
    // `x-inquiry-key` unredigiert, bis er im Produktionslog auffiel.
    LoggerModule.forRoot({
      pinoHttp: buildLogConfig(),
      // '{*pfad}' STATT DER VORGABE '*' — dieselbe Sache wie unten bei
      // `configure()`, nur an einer Stelle, die uns nicht gehört:
      // `nestjs-pino` registriert seine Middleware ab Werk auf
      // `[{ path: '*', method: ALL }]`, und `setGlobalPrefix('api')` macht
      // daraus `/api/*`.
      //
      // Nest 11 nimmt das noch an und schreibt beim Start zweimal eine
      // Warnung („Unsupported route path … Attempting to auto-convert").
      // Die Umschreibung ist eine Übergangshilfe: Fällt sie weg, ist es kein
      // Schönheitsfehler mehr, sondern ein „Missing parameter name" beim
      // Start — und dann protokolliert die Anwendung entweder gar nichts
      // mehr oder startet nicht.
      forRoutes: [{ path: '{*pfad}', method: RequestMethod.ALL }],
    }),
    // Der Auslöser des täglichen Zeitplans (Etappe 2). Ohne dieses Modul
    // bleibt @Cron wirkungslos.
    NestScheduleModule.forRoot(),
    PrismaModule,
    CryptoModule,
    AuditModule,
    // Tresor der Feldverschlüsselung (Entsperren, Einrichten, Umpacken).
    VaultModule,
    UserModule,
    SecurityLogModule,
    AuthModule,
    // Anmeldung über das Portal (nur im Modus `portal` erreichbar).
    SsoModule,
    CompanyModule,
    NoteModule,
    PublicModule,
    IntakeModule,
    TasksModule,
    NavigationModule,
    ScheduleModule,
    CoolifyModule,
    InstanceModule,
    InvoiceModule,
    // Etappe 5: Einwilligung (Double-Opt-in, Sperrliste) und der werbliche
    // Kanal. Die Reihenfolge ist keine Zufälligkeit — RundmailModule
    // importiert EinwilligungModule und bekommt von dort das Tor, ohne das es
    // keine werbliche Mail verschicken kann (R3).
    ConsentModule,
    BroadcastModule,
    // Betriebsschalter für alle Instanzen (Feedback). Die Instanzen lesen ihn
    // über GET /api/schalter.
    FeatureFlagModule,
    SettingsModule,
    // Sicherungsziel + Anbindung an den Sicherungs-Agent (Teil F).
    BackupSettingsModule,
  ],
  controllers: [AppController, RobotsController],
  providers: [
    // Reihenfolge: Tresor-Sperre zuerst (gesperrt = 423, ohne weitere Prüfung),
    // dann Rate-Limit vor CSRF-Prüfung.
    { provide: APP_GUARD, useClass: VaultLockGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware, RobotsMiddleware).forRoutes('{*pfad}');
    // '{*pfad}' STATT '*' ([NestJS 11]): platform-express 11 bringt Express 5
    // mit, und dessen path-to-regexp 8 kennt das nackte '*' nicht mehr — es
    // wirft beim Start "Missing parameter name". Die geschweifte Form ist der
    // benannte, optionale Sammelparameter und deckt dieselben Pfade ab.
  }
}
