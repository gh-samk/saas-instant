import {
  Controller,
  Get,
  NotFoundException,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import {
  COOKIE_SESSION,
  COOKIE_SSO,
  sessionCookieOptions,
  ssoFlowCookieOptions,
} from '../common/cookies';
import { BusinessError } from '../common/errors/business-error';
import { sourceFrom } from '../common/inquiry-source';
import { SessionService } from '../auth/session.service';
import { SsoInvalidError } from './sso.errors';
import { SsoService } from './sso.service';
import { emptyPage, redirectPage } from './sso-pages';

/** Abfrage von `GET /api/auth/sso/start`. */
export class SsoStartQuery {
  /** Pfad, zu dem es nach der Anmeldung zurückgeht. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  return?: string;

  /** `1` = Step-up (frischer Nachweis) statt Anmeldung. */
  @IsOptional()
  @IsIn(['0', '1'])
  stepup?: string;
}

const SSO_LIMIT = { default: { limit: 30, ttl: 60_000 } };

/**
 * Die Client-Seite der Portal-Anmeldung (OIDC Authorization Code + PKCE).
 *
 * Im Modus `single` gibt es diese Routen nicht (404).
 */
@Controller('auth/sso')
export class SsoController {
  constructor(
    private readonly sso: SsoService,
    private readonly session: SessionService,
    private readonly config: ConfigService,
  ) {}

  private requirePortalMode(): void {
    if (this.sso.mode !== 'portal') throw new NotFoundException();
  }

  /** Schickt den Browser zur Anmeldeseite des Portals (bzw. zum Step-up). */
  @Get('start')
  @Throttle(SSO_LIMIT)
  async start(
    @Query() query: SsoStartQuery,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    this.requirePortalMode();
    const stepUp = query.stepup === '1';
    let ssoSessionId: string | undefined;
    if (stepUp) {
      // Ein Step-up gibt es nur innerhalb einer laufenden Portal-Sitzung.
      const resolved = await this.session.resolve(
        req.cookies?.[COOKIE_SESSION] as string | undefined,
      );
      if (!resolved.ssoSession) {
        throw new UnauthorizedException('Keine Portal-Sitzung.');
      }
      ssoSessionId = resolved.ssoSession.id;
    }
    const started = await this.sso.start({
      returnPath: query.return,
      stepUp,
      ssoSessionId,
    });
    res.cookie(COOKIE_SSO, started.cookieValue, ssoFlowCookieOptions(this.config));
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, started.authorizeUrl);
  }

  /** Die Rücksprungadresse des Portals. */
  @Get('callback')
  @Throttle(SSO_LIMIT)
  async callback(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    this.requirePortalMode();
    res.setHeader('Cache-Control', 'no-store');
    const clear = ssoFlowCookieOptions(this.config);
    // `maxAge` gehört nicht in `clearCookie`.
    const { maxAge: _maxAge, ...clearOptions } = clear;
    const html = req.accepts(['json', 'html']) === 'html';
    try {
      const result = await this.sso.callback(
        query,
        req.cookies?.[COOKIE_SSO] as string | undefined,
        sourceFrom(req),
      );
      res.clearCookie(COOKIE_SSO, clearOptions);
      if (result.kind === 'login') {
        res.cookie(
          COOKIE_SESSION,
          result.sessionToken,
          sessionCookieOptions(this.config),
        );
      }
      if (html) {
        res
          .status(200)
          .type('html')
          .send(redirectPage('Angemeldet', 'Sie werden weitergeleitet.', result.returnPath));
      } else {
        res.status(200).json({ ok: true, returnPath: result.returnPath });
      }
    } catch (error) {
      res.clearCookie(COOKIE_SSO, clearOptions);
      if (!(error instanceof BusinessError)) throw error;
      const status = error.getStatus();
      if (html) {
        res
          .status(status)
          .type('html')
          .send(this.errorPage(error));
      } else {
        res
          .status(status)
          .json({ error: { code: error.errorCode, message: error.message } });
      }
    }
  }

  /** Die Seite zu einem Fehler des Callbacks, mit Weiterleitung in die Oberfläche. */
  private errorPage(error: BusinessError): string {
    if (error.errorCode === 'no_access') {
      return redirectPage(
        'Kein Zugriff auf diese Verwaltung',
        'Ihr Konto hat in dieser Verwaltung keine Rolle. Bitte wenden Sie sich an die Kontenverwaltung des Portals.',
        '/no-access',
      );
    }
    const stepUpReturn =
      error instanceof SsoInvalidError && error.stepUpReturn !== undefined
        ? error.stepUpReturn
        : undefined;
    const target =
      stepUpReturn === undefined
        ? '/login?sso=failed'
        : `${stepUpReturn}${stepUpReturn.includes('?') ? '&' : '?'}sso=failed`;
    return redirectPage(
      'Anmeldung fehlgeschlagen',
      'Die Anmeldung über das Portal ist fehlgeschlagen.',
      target,
    );
  }

  /**
   * Front-Channel-Logout: das Portal lädt diese Adresse in einem unsichtbaren
   * iframe, sobald die Portal-Sitzung endet.
   */
  @Get('frontchannel-logout')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async frontChannelLogout(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    this.requirePortalMode();
    await this.sso.frontChannelLogout(query['iss'], query['sid'], sourceFrom(req));
    // Die Seite wird vom PORTAL eingebettet; Helmet verbietet das sonst.
    res.removeHeader('X-Frame-Options');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; frame-ancestors ${this.sso.issuerOrigin()}`,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).type('html').send(emptyPage());
  }
}
