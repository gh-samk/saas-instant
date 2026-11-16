import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { IssuerProfile } from '@saas-instant/shared';
import type { SessionUser } from '../auth/session.service';
import { LoggedInUser } from '../common/decorators/logged-in-user.decorator';
import { AllowWhileLocked } from '../vault/allow-while-locked.decorator';
import { WithoutSecondFactor } from '../common/decorators/without-second-factor.decorator';
import { SecondFactorGuard } from '../common/guards/second-factor.guard';
import { SessionGuard } from '../common/guards/session.guard';
import { RequireAdmin } from '../common/decorators/require-role.decorator';
import { RoleGuard } from '../common/guards/role.guard';
import { sourceFrom } from '../common/inquiry-source';
import { IssuerUpdateDto } from './dto/issuer.dto';
import {
  IssuerProfileService,
  LOGO_MAX_BYTES,
  LogoInvalidError,
  type IssuerResponse,
} from './issuer-profile.service';

/**
 * Liest den Rumpf einer Anfrage bis `max` Bytes. Der Logo-Upload kommt als
 * rohes Bild (`Content-Type: image/png|jpeg`), damit der JSON-Parser mit
 * seiner kleinen Grenze nicht dazwischenkommt; mehr als `max` bricht ab.
 */
export function readBody(req: Request, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new LogoInvalidError('too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Einstellungen → Firmendaten.
 *
 * Lesen hängt nur an der Sitzung; SPEICHERN am zweiten Faktor (wie Preise):
 * Die Angaben stehen unveränderlich auf jeder künftigen Rechnung.
 */
@Controller('settings/issuer')
@UseGuards(SessionGuard, RoleGuard, SecondFactorGuard)
export class IssuerSettingsController {
  constructor(private readonly issuer: IssuerProfileService) {}

  @Get()
  @WithoutSecondFactor(
    'Rein lesend: Firmenangaben stehen auf jeder Rechnung; keine Geheimnisse.',
  )
  async get(): Promise<IssuerResponse> {
    return this.issuer.getResponse();
  }

  @RequireAdmin()
  @Put()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async update(
    @LoggedInUser() user: SessionUser,
    @Body() dto: IssuerUpdateDto,
    @Req() req: Request,
  ): Promise<IssuerResponse> {
    return this.issuer.update(
      dto.profile as unknown as IssuerProfile,
      dto.accentColor ?? null,
      user,
      sourceFrom(req),
    );
  }

  @RequireAdmin()
  @Post('logo')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async uploadLogo(
    @LoggedInUser() user: SessionUser,
    @Req() req: Request,
  ): Promise<IssuerResponse> {
    const declared = req.headers['content-type'];
    const data = await readBody(req, LOGO_MAX_BYTES);
    return this.issuer.setLogo(data, declared, user, sourceFrom(req));
  }

  @RequireAdmin()
  @Delete('logo')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async deleteLogo(
    @LoggedInUser() user: SessionUser,
    @Req() req: Request,
  ): Promise<IssuerResponse> {
    return this.issuer.deleteLogo(user, sourceFrom(req));
  }
}

/** Das Logo, anonym und rein lesend: die Anmeldeseite braucht es vor der Anmeldung. */
@AllowWhileLocked('Logo der Anmeldeseite, unverschlüsselt')
@Controller('public/logo')
export class PublicLogoController {
  constructor(private readonly issuer: IssuerProfileService) {}

  @Get()
  async logo(@Req() req: Request, @Res() res: Response): Promise<void> {
    const file = await this.issuer.logoFile();
    if (!file) {
      res.status(404).json({ error: { code: 'not_found', message: 'Kein Logo hinterlegt.' } });
      return;
    }
    const etag = `"${file.sha256}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Length', String(file.data.length));
    res.status(200).end(file.data);
  }
}
