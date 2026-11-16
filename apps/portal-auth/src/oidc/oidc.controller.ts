import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { cookieNames, clearCookie, readCookie } from '../common/cookies';
import { RateLimit, WithoutCsrf } from '../common/guards';
import { CONFIG, PortalConfig } from '../config';
import { KeysService } from '../keys/keys.service';
import { AuthorizeOutcome, OAuthError, OidcService } from './oidc.service';

const noStore = (res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
};

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

@Controller('.well-known')
export class WellKnownController {
  constructor(
    private readonly oidc: OidcService,
    private readonly keys: KeysService,
  ) {}

  @Get('openid-configuration')
  discovery(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'public, max-age=300');
    return this.oidc.discovery();
  }

  @Get('jwks.json')
  async jwks(@Res({ passthrough: true }) res: Response) {
    // Kurz zwischenspeichern: ein Schlüsselwechsel soll zügig ankommen.
    res.setHeader('Cache-Control', 'public, max-age=60');
    return this.keys.jwks();
  }
}

@Controller('oauth')
export class OauthController {
  constructor(
    private readonly oidc: OidcService,
    @Inject(CONFIG) private readonly config: PortalConfig,
  ) {}

  private answer(res: Response, outcome: AuthorizeOutcome): void {
    noStore(res);
    if (outcome.kind === 'redirect') res.redirect(302, outcome.url);
    else res.status(outcome.status).json({ error: outcome.error, error_description: outcome.description });
  }

  @Get('authorize')
  @RateLimit('authorize', 120)
  async authorize(@Query() query: Record<string, unknown>, @Req() req: Request, @Res() res: Response) {
    this.answer(res, await this.oidc.authorize(query, readCookie(req, cookieNames(this.config).session)));
  }

  /** Rückkehr von der Anmeldeseite (Link kommt vom Portal, nicht von der Verwaltung). */
  @Get('authorize/continue')
  @RateLimit('authorize', 120)
  async authorizeContinue(@Query('req') reqId: unknown, @Req() req: Request, @Res() res: Response) {
    this.answer(
      res,
      await this.oidc.continueRequest(typeof reqId === 'string' ? reqId : null, readCookie(req, cookieNames(this.config).session)),
    );
  }

  @WithoutCsrf(
    'Token-Endpunkt von OIDC: aufgerufen vom Server der Verwaltung (Back-Channel), ' +
      'ohne Browser und ohne Cookie. Geschützt durch Client-Geheimnis, Code und PKCE.',
  )
  @Post('token')
  @HttpCode(200)
  @RateLimit('token', 120)
  async token(@Body() body: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    try {
      return await this.oidc.token(body ?? {});
    } catch (error) {
      if (error instanceof OAuthError) {
        res.status(error.status);
        return { error: error.error, error_description: error.description };
      }
      throw error;
    }
  }

  @Get('logout')
  async logout(@Query() query: Record<string, unknown>, @Req() req: Request, @Res() res: Response) {
    noStore(res);
    const { target, frontchannel } = await this.oidc.logout(query, readCookie(req, cookieNames(this.config).session));
    clearCookie(res, this.config, cookieNames(this.config).session);
    if (frontchannel.length === 0) {
      res.redirect(302, target);
      return;
    }
    // Front-Channel: jede Verwaltung beendet in einem unsichtbaren iframe ihre
    // Sitzung; danach geht es weiter. Der Zeitgeber verhindert Hängenbleiben.
    const nonce = randomBytes(16).toString('base64');
    const origins = [...new Set(frontchannel.map((u) => new URL(u).origin))];
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; frame-src ${origins.join(' ')}; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`,
    );
    res.type('html').send(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Abmelden …</title>` +
        `<meta http-equiv="refresh" content="6;url=${escapeHtml(target)}">` +
        `<style nonce="${nonce}">iframe{display:none}body{font-family:system-ui,sans-serif;padding:2rem}</style></head><body>` +
        `<p>Du wirst abgemeldet …</p>` +
        frontchannel.map((u) => `<iframe src="${escapeHtml(u)}" title="Abmeldung" aria-hidden="true"></iframe>`).join('') +
        `<script nonce="${nonce}">(function(){var t=${JSON.stringify(target).replace(/</g, '\\u003c')};` +
        `var f=document.querySelectorAll('iframe'),n=f.length,done=false;` +
        `function go(){if(!done){done=true;location.replace(t);}}` +
        `f.forEach(function(x){x.addEventListener('load',function(){if(--n<=0)go();});});` +
        `setTimeout(go,3000);})();</script></body></html>`,
    );
  }
}
