import { SetMetadata } from '@nestjs/common';

export const EVIDENCE_ALWAYS = 'evidenceAlways';

/**
 * Schaltet das Frischefenster des `ZweitfaktorGuard` für EINE Route ab.
 *
 * Der Guard lässt den Nachweis sonst weg, wenn die Sitzung jünger als zehn
 * Minuten ist — richtig für Alltagsvorgänge, damit niemand sein Passwort auf
 * Zuruf eintippt. Für Geheimnisse, die NICHT dieser Anwendung gehören, ist
 * das zu wenig: Der Einrichtungslink einer Kundeninstanz macht zum
 * Administrator einer FREMDEN Installation. Wer ihn holt, weist sich immer
 * aus, auch fünf Minuten nach der Anmeldung. Die Begründung steht an der
 * Route.
 */
export const EvidenceAlways = (reason: string) =>
  SetMetadata(EVIDENCE_ALWAYS, reason);
