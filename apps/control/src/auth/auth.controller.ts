import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { randomBytes } from 'crypto';
import type { Request, Response } from 'express';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server';
import { sourceFrom } from '../common/inquiry-source';
import {
  loginCookieOptions,
  COOKIE_LOGIN,
  COOKIE_CSRF,
  COOKIE_TRUSTED_DEVICE,
  COOKIE_SESSION,
  csrfCookieOptions,
  trustedDeviceCookieOptions,
  sessionCookieOptions,
} from '../common/cookies';
import { LoggedInUser } from '../common/decorators/logged-in-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import { LoginService } from './login.service';
import type { LoginDone } from './login.service';
import {
  LoginCodeRequestDto,
  LoginDto,
  PasskeyCompleteDto,
  PasskeyStartDto,
  SecondFactorEmailCodeDto,
  SecondFactorTotpDto,
  SecondFactorRecoveryDto,
} from './dto/login.dto';
import { CODE_AGAIN_BY_MS } from './email-login-code.service';
import type { FactorKind } from './factors';
import {
  EmergencyCompleteDto,
  EmergencyPasswordDto,
  EmergencyStartDto,
} from './dto/access.dto';
import { asLoginResponse, asRegistrationResponse } from './dto/webauthn-response';
import { EmergencyService } from './emergency.service';
import type { SessionUser } from './session.service';
import { AccessService } from './access.service';

/** Einheitliches Rate-Limit auf allen Anmelderouten: 5 Versuche je Minute. */
const LOGIN_LIMIT = { default: { limit: 5, ttl: 60_000 } };

/** Antwort einer erfolgreich abgeschlossenen Anmeldung. */
interface LoggedInResponse {
  user: SessionUser;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly loginService: LoginService,
    private readonly access: AccessService,
    private readonly emergency: EmergencyService,
    private readonly config: ConfigService,
  ) {}

  /** Setzt Sitzungs- und Merk-Cookie einer fertigen Anmeldung. */
  private setLoginCookies(res: Response, done: LoginDone): void {
    res.cookie(
      COOKIE_SESSION,
      done.sessionToken,
      sessionCookieOptions(this.config),
    );
    res.clearCookie(COOKIE_LOGIN, loginCookieOptions(this.config));
    if (done.trustedToken) {
      res.cookie(
        COOKIE_TRUSTED_DEVICE,
        done.trustedToken,
        trustedDeviceCookieOptions(this.config),
      );
    }
  }

  /**
   * Liefert (und setzt) ein CSRF-Token für das Double-Submit-Verfahren.
   * Muss vor jeder schreibenden Anfrage einmal abgerufen werden.
   */
  @Get('csrf')
  csrf(@Res({ passthrough: true }) res: Response): { csrfToken: string } {
    const csrfToken = randomBytes(24).toString('hex');
    res.cookie(COOKIE_CSRF, csrfToken, csrfCookieOptions(this.config));
    return { csrfToken };
  }

  /** Der angemeldete Benutzer samt Stand der Ersteinrichtung. */
  @Get('me')
  @UseGuards(SessionGuard)
  async me(@LoggedInUser() user: SessionUser) {
    return this.access.state(user);
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async logout(
    @LoggedInUser() user: SessionUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    await this.loginService.logout(user, sourceFrom(req));
    res.clearCookie(COOKIE_SESSION, sessionCookieOptions(this.config));
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Weg 1, Schritt 1: Benutzername oder E-Mail plus Passwort
  // -------------------------------------------------------------------------

  /**
   * Prüft Kennung und Passwort.
   *
   * Auf einem gemerkten Browser entsteht sofort eine Sitzung; sonst kommt
   * `{ zweiterFaktorErforderlich: true }` zurück und der Vorgang wird in einem
   * kurzlebigen httpOnly-Cookie gehalten.
   */
  @Post('login')
  @HttpCode(200)
  @Throttle(LOGIN_LIMIT)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<
    | LoggedInResponse
    | { secondFactorRequired: true; factors: FactorKind[] }
  > {
    const result = await this.loginService.passwordLogin(
      dto.identifier,
      dto.password,
      req.cookies?.[COOKIE_TRUSTED_DEVICE] as string | undefined,
      sourceFrom(req),
    );

    if (result.kind === 'second-factor') {
      res.cookie(
        COOKIE_LOGIN,
        result.flowToken,
        loginCookieOptions(this.config),
      );
      return { secondFactorRequired: true, factors: result.factors };
    }

    this.setLoginCookies(res, result);
    return { user: result.user };
  }

  // -------------------------------------------------------------------------
  // Weg 1, Schritt 2: zweiter Faktor
  // -------------------------------------------------------------------------

  /** Schließt die Anmeldung mit dem Code aus der Authenticator-App ab. */
  @Post('login/totp')
  @HttpCode(200)
  @Throttle(LOGIN_LIMIT)
  async secondFactorTotp(
    @Body() dto: SecondFactorTotpDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoggedInResponse> {
    const done = await this.loginService.secondFactorTotp(
      req.cookies?.[COOKIE_LOGIN] as string | undefined,
      dto.code,
      dto.deviceRemember === true,
      sourceFrom(req),
    );
    this.setLoginCookies(res, done);
    return { user: done.user };
  }

  /**
   * Fordert einen achtstelligen Anmeldecode per E-Mail an.
   *
   * Antwortet IMMER gleich — auch bei unbekannter Kennung, bei nicht
   * eingerichtetem Faktor und wenn die 60-Sekunden-Sperre greift. Sonst ließe
   * sich hier unauthentifiziert abfragen, welche Konten es gibt.
   *
   * `erneutMoeglichInSekunden` ist deshalb die KONSTANTE Wartezeit und keine
   * Restzeit: eine mitlaufende Restzeit wäre genau das Leck, das die
   * Einheitsantwort verhindern soll. Die Oberfläche zählt ab dem eigenen
   * Absenden herunter, dafür braucht sie den Server nicht.
   */
  @Post('login-code/request')
  @HttpCode(200)
  @Throttle(LOGIN_LIMIT)
  async loginCodeRequest(
    @Body() dto: LoginCodeRequestDto,
    @Req() req: Request,
  ): Promise<{ requested: true; againPossibleInSeconds: number }> {
    await this.loginService.requestLoginCode(dto.identifier, sourceFrom(req));
    return {
      requested: true,
      againPossibleInSeconds: CODE_AGAIN_BY_MS / 1000,
    };
  }

  /** Schließt die Anmeldung mit dem achtstelligen Code aus der E-Mail ab. */
  @Post('login/email-code')
  @HttpCode(200)
  @Throttle(LOGIN_LIMIT)
  async secondFactorEmailCode(
    @Body() dto: SecondFactorEmailCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoggedInResponse> {
    const done = await this.loginService.secondFactorEmailCode(
      req.cookies?.[COOKIE_LOGIN] as string | undefined,
      dto.code,
      dto.deviceRemember === true,
      sourceFrom(req),
    );
    this.setLoginCookies(res, done);
    return { user: done.user };
  }

  /**
   * Schließt die Anmeldung ersatzweise mit einem Wiederherstellungscode ab.
   * Der Code ist danach verbraucht; ein Merk-Gerät entsteht dabei nicht.
   */
  @Post('login/recovery-code')
  @HttpCode(200)
  @Throttle(LOGIN_LIMIT)
  async secondFactorRecoveryCode(
    @Body() dto: SecondFactorRecoveryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoggedInResponse> {
    const done = await this.loginService.secondFactorRecoveryCode(
      req.cookies?.[COOKIE_LOGIN] as string | undefined,
      dto.code,
      sourceFrom(req),
    );
    this.setLoginCookies(res, done);
    return { user: done.user };
  }

  // -------------------------------------------------------------------------
  // Weg 2: Passkey (einstufig, ersetzt Passwort und zweiten Faktor zugleich)
  // -------------------------------------------------------------------------

  @Post('passkey/login/start')
  @HttpCode(200)
  @Throttle(LOGIN_LIMIT)
  async passkeyStart(
    @Body() dto: PasskeyStartDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ options: PublicKeyCredentialRequestOptionsJSON }> {
    // `dto.kennung` wird bewusst NICHT ausgewertet (siehe passkeyStart). Das
    // Feld bleibt im DTO erlaubt, damit ein Client, der es noch mitschickt,
    // keine 400 bekommt — `forbidNonWhitelisted` würde es sonst abweisen.
    const { options, flowToken } = await this.loginService.passkeyStart();
    res.cookie(
      COOKIE_LOGIN,
      flowToken,
      loginCookieOptions(this.config),
    );
    return { options };
  }

  @Post('passkey/login/complete')
  @HttpCode(200)
  @Throttle(LOGIN_LIMIT)
  async passkeyComplete(
    @Body() dto: PasskeyCompleteDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoggedInResponse> {
    const done = await this.loginService.passkeyComplete(
      req.cookies?.[COOKIE_LOGIN] as string | undefined,
      asLoginResponse(dto.response),
      sourceFrom(req),
    );
    this.setLoginCookies(res, done);
    return { user: done.user };
  }

  // -------------------------------------------------------------------------
  // Notfallzugang: Passkey anlegen oder Passwort setzen
  // -------------------------------------------------------------------------

  /**
   * Prüft einen Notfall-Link, ohne ihn zu verbrauchen.
   *
   * Bewusst POST statt GET: so steht der Token im Body und nicht in
   * Zugriffsprotokollen oder im Referrer.
   */
  @Post('emergency/check')
  @HttpCode(200)
  @Throttle(LOGIN_LIMIT)
  async emergencyCheck(@Body() dto: EmergencyStartDto): Promise<{
    valid: boolean;
    kind?: 'passkey' | 'password';
    username?: string;
    secondsRemaining?: number;
  }> {
    // Restsekunden für den Countdown auf der Notfallseite. Abgelaufen oder
    // verbraucht bleibt es bei `{ gueltig: false }` — dann gibt es nichts
    // herunterzuzählen.
    for (const kind of ['passkey', 'password'] as const) {
      const verified = await this.emergency.check(dto.token, kind);
      if (verified) {
        return {
          valid: true,
          kind,
          username: verified.username,
          secondsRemaining: verified.secondsRemaining,
        };
      }
    }
    return { valid: false };
  }

  /** Startet die Passkey-Registrierung über einen Notfall-Link. */
  @Post('emergency/enrollment/start')
  @HttpCode(200)
  @Throttle(LOGIN_LIMIT)
  async emergencyStart(
    @Body() dto: EmergencyStartDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const verified = await this.emergency.check(dto.token, 'passkey');
    if (!verified) {
      return { valid: false as const };
    }
    const { options, flowToken } =
      await this.access.registrationStartEmergency({
        id: verified.userId,
        email: verified.email,
        name: verified.name,
      });
    res.cookie(
      COOKIE_LOGIN,
      flowToken,
      loginCookieOptions(this.config),
    );
    return { valid: true as const, options };
  }

  /**
   * Schließt die Passkey-Registrierung ab: verbraucht den Link, speichert den
   * Passkey und meldet den Benutzer direkt an. Der Passkey ist einstufig, ein
   * zweiter Faktor ist daher nicht nötig.
   */
  @Post('emergency/enrollment/complete')
  @HttpCode(200)
  @Throttle(LOGIN_LIMIT)
  async emergencyComplete(
    @Body() dto: EmergencyCompleteDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoggedInResponse> {
    const source = sourceFrom(req);

    // Drei Schritte, in genau dieser Reihenfolge:
    //
    // 1. RESERVIEREN — atomar, bevor irgendetwas geprüft wird. Ohne das kämen
    //    zwei gleichzeitige Aufrufe beide durch, legten beide einen Passkey an,
    //    und der zweite entwertete über die Sitzungs-Generation die Sitzung des
    //    ersten wieder.
    // 2. PASSKEY PRÜFEN und speichern.
    // 3. Erst bei Erfolg BESTÄTIGEN. Scheitert Schritt 2, wird die Reservierung
    //    zurückgenommen — ein 15-Minuten-Link darf nicht an einem
    //    fehlgeschlagenen WebAuthn-Dialog verbrennen.
    const reserved = await this.emergency.reserve(dto.token, 'passkey');

    let sessionToken: string;
    try {
      ({ sessionToken } = await this.access.registrationComplete(
        reserved.userId,
        req.cookies?.[COOKIE_LOGIN] as string | undefined,
        asRegistrationResponse(dto.response),
        dto.label,
        source,
      ));
    } catch (error) {
      await this.emergency.release(reserved.registrationId);
      throw error;
    }

    await this.emergency.confirmRedemption(reserved, source);

    const user: SessionUser = {
      id: reserved.userId,
      name: reserved.name,
      username: reserved.username,
      email: reserved.email,
      role: reserved.role,
    };
    this.setLoginCookies(res, { kind: 'session', user, sessionToken });
    return { user };
  }

  /**
   * Setzt über einen Notfall-Link ein neues Passwort.
   *
   * Es entsteht bewusst KEINE Sitzung: der Benutzer meldet sich danach regulär
   * mit Passwort UND zweitem Faktor an. Ein Passwort-Link allein ist niemals
   * ein vollständiger Zugang.
   */
  @Post('emergency/password/set')
  @HttpCode(200)
  @Throttle(LOGIN_LIMIT)
  async emergencyPasswordSet(
    @Body() dto: EmergencyPasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true; username: string }> {
    const { username } = await this.emergency.setPassword(
      dto.token,
      dto.password,
      sourceFrom(req),
    );
    // Alle Merk-Geräte wurden entwertet — auch das dieses Browsers.
    res.clearCookie(COOKIE_TRUSTED_DEVICE, trustedDeviceCookieOptions(this.config));
    return { ok: true, username };
  }
}
