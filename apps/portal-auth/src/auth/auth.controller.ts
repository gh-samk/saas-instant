import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import { generateCsrfToken } from '@saas-instant/auth-core';
import type { AuthenticationResponseJSON } from '@saas-instant/auth-core';
import { AccountsService } from '../accounts/accounts.service';
import { clearCookie, clientIp, cookieNames, csrfCookieOptions, readCookie, sessionCookieOptions } from '../common/cookies';
import { RateLimit } from '../common/guards';
import { CONFIG, PortalConfig } from '../config';
import { SESSION_ABSOLUTE_MS, SessionsService } from '../sessions/sessions.service';
import { LoginResult, LoginService } from './login.service';
import { AuditService } from '../audit/audit.service';

class LoginDto {
  @IsString() @MaxLength(254) email!: string;
  @IsString() @MaxLength(200) password!: string;
  @IsOptional() @IsString() @MaxLength(64) code?: string;
  @IsOptional() @IsUUID() req?: string;
}

class PasskeyLoginDto {
  @IsObject() response!: Record<string, unknown>;
  @IsOptional() @IsUUID() req?: string;
}

class TokenDto {
  @IsString() @MinLength(10) @MaxLength(200) token!: string;
}

class CompleteSetupDto extends TokenDto {
  @IsString() @MaxLength(200) password!: string;
  @IsString() @MaxLength(64) code!: string;
}

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly login: LoginService,
    private readonly sessions: SessionsService,
    private readonly accounts: AccountsService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: PortalConfig,
  ) {}

  private async currentSession(req: Request) {
    const token = readCookie(req, cookieNames(this.config).session);
    return token ? this.sessions.resolve(token) : null;
  }

  private setSession(res: Response, result: LoginResult): void {
    res.cookie(cookieNames(this.config).session, result.token, sessionCookieOptions(this.config, SESSION_ABSOLUTE_MS));
  }

  /** Setzt (falls nötig) das CSRF-Cookie und nennt den Wert für den Header `x-csrf-token`. */
  @Get('csrf')
  csrf(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const name = cookieNames(this.config).csrf;
    const existing = readCookie(req, name);
    const value = existing ?? generateCsrfToken();
    if (!existing) res.cookie(name, value, csrfCookieOptions(this.config));
    res.setHeader('Cache-Control', 'no-store');
    return { csrf: value };
  }

  @Post('login')
  @HttpCode(200)
  @RateLimit('login', 20)
  async doLogin(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.login.login(dto, {
      ip: clientIp(req),
      current: await this.currentSession(req),
      reqId: dto.req,
    });
    this.setSession(res, result);
    res.setHeader('Cache-Control', 'no-store');
    return { ok: true, next: result.next, amr: result.amr };
  }

  @Post('passkey/options')
  @HttpCode(200)
  @RateLimit('passkey', 30)
  async passkeyOptions(@Res({ passthrough: true }) res: Response) {
    const { options, challengeId } = await this.login.passkeyOptions();
    res.cookie(cookieNames(this.config).challenge, challengeId, {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: 5 * 60 * 1000,
    });
    res.setHeader('Cache-Control', 'no-store');
    return options;
  }

  @Post('passkey/login')
  @HttpCode(200)
  @RateLimit('passkey', 30)
  async passkeyLogin(@Body() dto: PasskeyLoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const challengeName = cookieNames(this.config).challenge;
    const result = await this.login.passkeyLogin(
      { challengeId: readCookie(req, challengeName), response: dto.response as unknown as AuthenticationResponseJSON },
      { ip: clientIp(req), current: await this.currentSession(req), reqId: dto.req },
    );
    clearCookie(res, this.config, challengeName);
    this.setSession(res, result);
    res.setHeader('Cache-Control', 'no-store');
    return { ok: true, next: result.next, amr: result.amr };
  }

  /** Beendet nur die Sitzung dieses Browsers (die Abmeldung aus den Verwaltungen läuft über /oauth/logout). */
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const current = await this.currentSession(req);
    if (current) await this.sessions.revoke(current.session.id);
    clearCookie(res, this.config, cookieNames(this.config).session);
    return { ok: true };
  }

  // -------- Einrichtung per Link ------------------------------------------------

  @Post('setup/begin')
  @HttpCode(200)
  @RateLimit('setup', 20)
  async setupBegin(@Body() dto: TokenDto, @Res({ passthrough: true }) res: Response) {
    const begin = await this.accounts.beginSetup(dto.token);
    res.setHeader('Cache-Control', 'no-store');
    return {
      email: begin.email,
      name: begin.name,
      purpose: begin.purpose,
      totpSecret: begin.totp.secretBase32,
      otpauthUrl: begin.totp.otpauthUrl,
      qrDataUrl: begin.totp.qrDataUrl,
    };
  }

  @Post('setup/complete')
  @HttpCode(200)
  @RateLimit('setup', 20)
  async setupComplete(@Body() dto: CompleteSetupDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.accounts.completeSetup(dto, clientIp(req));
    res.setHeader('Cache-Control', 'no-store');
    return { ok: true, recoveryCodes: result.recoveryCodes };
  }
}
