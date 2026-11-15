import 'reflect-metadata';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_URL_DEFAULT } from './common/app-defaults';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { assertJwtSecret } from './auth/session.service';
import { inquiryHopsFrom } from './common/inquiry-tracker';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { NullAsJsonInterceptor } from './common/interceptors/null-as-json.interceptor';
import { ControlCharsPipe } from './common/pipes/control-chars.pipe';
import { senderAddresses, checkSenderAlignment } from './mail/sender';
import { checkTlsRequirement } from './mail/tls-requirement';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  const config = app.get(ConfigService);

  // Ein schwaches oder fehlendes JWT_SECRET soll den Start verhindern, nicht
  // erst beim ersten Token auffallen.
  assertJwtSecret(config.get<string>('JWT_SECRET'));

  // Vor allem anderen: in Produktion darf die Verschlüsselung des
  // Postausgangs nicht abgeschaltet sein. Lieber gar nicht starten als den
  // zweiten Faktor im Klartext verschicken.
  checkTlsRequirement(
    config.get<string>('NODE_ENV'),
    config.get<string>('SMTP_TLS_ERZWINGEN'),
  );

  // Und ebenfalls vor allem anderen: Liegen Absender und Rückweg auf
  // derselben Domäne? Die Domäne hat DMARC auf `p=quarantine` mit `aspf=s`
  // stehen und kein DKIM — eine abweichende Domäne im Envelope-From bedeutet
  // damit: Spam-Ordner, und zwar zuerst für die Rechnungen. Eine Warnung wäre
  // zu wenig: Der Fehler ist im Postausgangslog unauffällig und fällt erst
  // Wochen später daran auf, dass niemand zahlt. Siehe `mail/absender.ts`.
  checkSenderAlignment(
    config.get<string>('NODE_ENV'),
    senderAddresses(config),
  );

  app.useLogger(app.get(Logger));
  // /robots.txt muss in der Wurzel liegen, nicht unter /api.
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'robots.txt', method: RequestMethod.GET }],
  });

  // Wie viele Reverse-Proxys stehen vor dieser Anwendung?
  //
  // Der Wert entscheidet, welchen Eintrag aus `X-Forwarded-For` Express als
  // `req.ip` nimmt — und damit, welche Adresse im Audit-Log landet (AK18) und
  // wogegen das Rate-Limit zählt. Er MUSS zur Betriebsart passen:
  //
  //   0  Anwendung direkt erreichbar. `req.ip` ist die Peer-Adresse und damit
  //      nicht fälschbar. Sicherer Standard.
  //   1  Genau ein Proxy davor (nur nginx).
  //   2  Coolify: Traefik -> nginx -> hier. Erst dann steht die echte
  //      Client-Adresse im Log.
  //
  // Zu NIEDRIG heißt: die Proxy-Adresse steht im Log statt der des Clients.
  // Zu HOCH heißt: ein selbst gesetzter X-Forwarded-For wird geglaubt, die
  // IP im Nachweis ist frei erfunden und das Rate-Limit umgehbar.
  // `Number('')` ist 0 — eine leer gesetzte Variable fiele also still auf den
  // sicheren Standard, statt aufzufallen. Leerstring wird deshalb wie „nicht
  // gesetzt" behandelt; jeder andere ungültige Wert bricht den Start ab.
  const trustProxyRaw = (
    config.get<string>('CONTROL_TRUST_PROXY') ?? ''
  ).trim();
  const trustProxy = trustProxyRaw === '' ? 0 : Number(trustProxyRaw);
  if (!Number.isInteger(trustProxy) || trustProxy < 0) {
    throw new Error(
      `CONTROL_TRUST_PROXY muss eine ganze Zahl >= 0 sein, war "${trustProxyRaw}". ` +
        'Siehe apps/control/.env.example für die passenden Werte je Betriebsart.',
    );
  }
  app.set('trust proxy', trustProxy);

  // Die LÄNGERE Kette des öffentlichen Anfragewegs ([W1]). Hier nur geprüft,
  // damit ein unsinniger Wert beim START auffällt und nicht erst bei der
  // ersten Anfrage als 500 — benutzt wird er im `getTracker` des Throttlers.
  inquiryHopsFrom(config.get<string>('CONTROL_INQUIRY_TRUST_PROXY'));

  // CORS vor Helmet: OPTIONS-Preflight wird korrekt beantwortet.
  // credentials: true ist Pflicht für die Cookie-Anmeldung.
  const appUrl = config.get<string>('CONTROL_APP_URL', APP_URL_DEFAULT);
  app.enableCors({
    origin: appUrl,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-request-id', 'x-csrf-token'],
    exposedHeaders: ['x-request-id'],
  });

  app.use(helmet());
  app.use(cookieParser());

  // whitelist: unbekannte Felder verwerfen; forbidNonWhitelisted: sie ablehnen;
  // transform: DTO-Instanzen samt Typkonvertierung erzeugen.
  app.useGlobalPipes(
    // ZUERST die Steuerzeichen abweisen, dann validieren: Ein NUL-Byte in
    // einem Textfeld brach sonst erst in der Datenbankschicht ab und wurde zu
    // `500 interner_fehler` ([W8]).
    new ControlCharsPipe(),
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  // Eine Route, die „gibt es gerade nicht" beantwortet, muss `null` senden und
  // nicht einen leeren Body. Begründung im Interceptor.
  app.useGlobalInterceptors(new NullAsJsonInterceptor());

  const port = config.get<number>('PORT', 3001);
  await app.listen(port);
}

void bootstrap();
