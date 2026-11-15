import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { SessionUser } from '../auth/session.service';
import { LoggedInUser } from '../common/decorators/logged-in-user.decorator';
import { SecondFactorGuard } from '../common/guards/second-factor.guard';
import { SessionGuard } from '../common/guards/session.guard';
import { sourceFrom } from '../common/inquiry-source';
import { GobdExportDto } from './dto/invoice.dto';
import { GobdExportService } from './gobd-export.service';
import { asActor } from './invoice.controller';

/** Rollen, die den Pruefer-Export ausloesen duerfen (`staff` ist unbenutzt). */
const EXPORT_ROLES: readonly string[] = ['owner', 'administrator'];

/**
 * GOBD-EXPORT (PRUEFER-ZUGRIFF).
 *
 * `GET /api/invoices/export/gobd?from=YYYY-MM-DD&to=YYYY-MM-DD`
 *
 * Hinter dem `SecondFactorGuard`: Der Export enthaelt ALLE Belege eines
 * Zeitraums samt Empfaengerdaten. Ein GET hat keinen Body, deshalb greift hier
 * nur das Frischefenster der Sitzung. Wer den Nachweis ausdruecklich erbringen
 * muss (Passwort/TOTP), nutzt dieselbe Route als `POST` mit `currentPassword`
 * oder `totpCode` im Body. Beide Wege sind auditiert (`invoice.gobd_export`).
 */
@Controller()
@UseGuards(SessionGuard, SecondFactorGuard)
export class GobdExportController {
  constructor(private readonly exports: GobdExportService) {}

  @Get('invoices/export/gobd')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async exportGet(
    @LoggedInUser() user: SessionUser,
    @Query() query: GobdExportDto,
    @Req() req: Request,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(user, query, req, response);
  }

  @Post('invoices/export/gobd')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async exportPost(
    @LoggedInUser() user: SessionUser,
    @Body() body: GobdExportDto,
    @Req() req: Request,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(user, body, req, response);
  }

  private async run(
    user: SessionUser,
    dto: GobdExportDto,
    req: Request,
    response: Response,
  ): Promise<void> {
    if (!EXPORT_ROLES.includes(user.role)) {
      throw new ForbiddenException();
    }
    const range = { from: dto.from, to: dto.to };
    // Zeitraum und Menge pruefen, BEVOR Header gesendet werden — Fehler gehen
    // so als normale JSON-Antwort hinaus.
    await this.exports.prepare(range);

    response
      .status(200)
      .setHeader('Content-Type', 'application/zip')
      .setHeader('Cache-Control', 'no-store')
      .setHeader(
        'Content-Disposition',
        `attachment; filename="${this.exports.filename(range)}"`,
      );
    try {
      await this.exports.stream(range, asActor(user), sourceFrom(req), (chunk) =>
        writeWithBackpressure(response, chunk),
      );
      response.end();
    } catch (error) {
      // Header sind raus: ein abgebrochenes Archiv muss als Abbruch erkennbar
      // sein, nicht als vollstaendige Datei.
      response.destroy(error instanceof Error ? error : undefined);
    }
  }
}

function writeWithBackpressure(response: Response, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    if (response.destroyed) {
      reject(new Error('Verbindung geschlossen'));
      return;
    }
    if (response.write(chunk)) {
      resolve();
      return;
    }
    const onDrain = (): void => {
      response.off('close', onClose);
      resolve();
    };
    const onClose = (): void => {
      response.off('drain', onDrain);
      reject(new Error('Verbindung geschlossen'));
    };
    response.once('drain', onDrain);
    response.once('close', onClose);
  });
}
