import { Logger } from '@nestjs/common';
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { VaultService } from './vault.service';

/**
 * Nachtjobs, Mahnläufe, Kennzahlen-Abruf und Integritätslauf lesen Kundendaten.
 * Solange der Tresor gesperrt ist, werden alle `@Cron`-Jobs angehalten und erst
 * beim Entsperren gestartet. Ein späteres `lock()` stoppt sie NICHT (Sperren gibt
 * es nur durch Neustart oder ausdrücklichen Aufruf).
 *
 * Aufruf in `main.ts` NACH `app.init()`, wenn der Scheduler seine Jobs
 * gestartet hat.
 */
export function gateCronJobs(
  vault: VaultService,
  registry: SchedulerRegistry,
  logger = new Logger('VaultCronGate'),
): void {
  if (vault.isUnlocked()) return;
  const jobs = [...registry.getCronJobs().entries()];
  for (const [, job] of jobs) job.stop();
  logger.log(`Tresor gesperrt: ${jobs.length} Cron-Jobs angehalten bis zum Entsperren.`);
  vault.onUnlocked(() => {
    for (const [, job] of jobs) job.start();
    logger.log(`Tresor entsperrt: ${jobs.length} Cron-Jobs gestartet.`);
  });
}
