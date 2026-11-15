import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { sourceFrom } from '../common/inquiry-source';
import { WithoutCsrf } from '../common/decorators/without-csrf.decorator';
import { BackupReportDto } from './dto/instance.dto';
import { BackupKeyGuard } from './backup-key.guard';
import { BackupService } from './backup.service';

/**
 * Meldeweg des externen Sicherungswerkzeugs.
 *
 * Kein `SessionGuard` — der Aufrufer ist ein Skript auf dem Server, kein
 * Mensch. An seine Stelle tritt der Schlüssel im Header
 * (`BackupKeyGuard`), zeitkonstant verglichen, ohne den die Route
 * gar nicht existiert (404).
 *
 * DIE ROUTE LEGT AN UND BERICHTIGT. Sie kann keine Sicherung löschen und
 * keine zurückspielen; beides gibt es in diesem System nicht (R1, R4, E3-15).
 */
@Controller('backups')
@UseGuards(BackupKeyGuard)
export class BackupController {
  constructor(private readonly backups: BackupService) {}

  @WithoutCsrf(
    'Server-zu-Server-Weg: das Sicherungswerkzeug läuft auf dem Server und ' +
      'weist sich mit CONTROL_BACKUP_KEY im Header aus. Es hat kein ' +
      'CSRF-Cookie, und die Route wertet keine Sitzung aus — es gibt also ' +
      'keine fremde Sitzung, die sich missbrauchen ließe.',
  )
  @Post()
  @HttpCode(200)
  // Zweimal täglich je Instanz. 60 je Minute lässt einen Nachholstapel zu.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async report(
    @Body() dto: BackupReportDto,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    return this.backups.report(dto, sourceFrom(req).ip);
  }
}
