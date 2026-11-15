import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../common/guards/session.guard';
import { AuditService } from './audit.service';
import type { SecurityEvent } from './audit-read';

/**
 * ===========================================================================
 * DAS SICHERHEITSPROTOKOLL — lesen, und ausschliesslich lesen
 * ===========================================================================
 *
 * R6 verlangt ein Audit-Log; es gab eines, seit der ersten Etappe, mit rund
 * sechzig Aktionen. Was fehlte, war der Weg, es anzusehen — man kam nur über
 * `psql` daran. Ein Protokoll, das niemand liest, erfüllt seinen Zweck erst zur
 * Hälfte: Es belegt im Nachhinein, warnt aber nie.
 *
 * NUR DIE SITZUNG, KEIN ZWEITER FAKTOR. Dasselbe Kriterium wie überall in
 * diesem System: Der zweite Faktor steht vor Handlungen, die sich nicht
 * zurücknehmen lassen. Diese Route ändert nichts. Sie hinter den Faktor zu
 * legen hiesse ausserdem, ausgerechnet den Blick auf verdächtige Anmeldungen
 * zu erschweren — und den will man im Zweifel sofort.
 *
 * ES GIBT KEIN GEGENSTÜCK. Kein Löschen, kein Ändern, kein „als gelesen
 * markieren". Ein Audit-Log, an dem sich etwas ändern lässt, ist keines.
 */
@Controller('audit')
@UseGuards(SessionGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get('security')
  async security(
    @Query('limit') limit?: string,
  ): Promise<SecurityEvent[]> {
    // Eine unbrauchbare Angabe wird zur Vorgabe, nicht zum Fehler: Der
    // Parameter ist Komfort, und ein 400 an dieser Stelle verhinderte den
    // Blick ins Protokoll wegen eines Tippfehlers in der URL.
    const number = Number(limit);
    return this.audit.securityLog(
      Number.isFinite(number) && number > 0 ? Math.floor(number) : 100,
    );
  }
}
