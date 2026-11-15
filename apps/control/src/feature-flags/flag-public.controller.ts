import { Controller, Get, Header } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { PublicFlagState } from './feature-flag.service';
import { FeatureFlagService } from './feature-flag.service';

/**
 * DER STAND DER FUNKTIONSSCHALTER FÜR DIE KUNDENINSTANZEN.
 *
 * Anonym und AUSSCHLIESSLICH LESEND: Die Antwort sind einzelne Wahrheitswerte
 * (`{ "feedback": true }`) — kein Personenbezug, keine Kennung, nichts, woraus
 * sich eine Organisation oder Instanz ablesen ließe. Die Instanzen fragen hier
 * alle paar Minuten nach; so muss die Verwaltung für einen Schalter nichts auf
 * eine Instanz schreiben (R1).
 *
 * BEWUSST NICHT UNTER `/api/oeffentlich`: Dort gilt der Anfrage-Schlüssel, und
 * `inquiry-tracker.ts` zählt diesen Pfad nach der Proxy-Kette der Webseite.
 *
 * Das Limit ist großzügig, weil alle Instanzen desselben Servers mit EINER
 * Adresse kommen — nach einem gemeinsamen Ausrollen fragen sie gleichzeitig.
 */
@Controller('flags')
export class FlagPublicController {
  constructor(private readonly flag: FeatureFlagService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  async state(): Promise<PublicFlagState> {
    return this.flag.publicState();
  }
}
