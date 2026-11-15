import { Inject, Injectable, Logger } from '@nestjs/common';
import { today, toDate } from '@saas-instant/shared';
import { CoolifyConfigService, instanceHost } from '../coolify/coolify.config';
import { PrismaService } from '../prisma/prisma.service';
import { invitationOpenFrom, toMetrics } from './instance.response';
import type { InstanceStatus } from './instance.types';
import {
  SETUP_STATUS_FETCH,
  SETUP_STATUS_TIMEOUT_MS,
  type SetupStatusFetch,
} from './setup-status';

/**
 * ===========================================================================
 * IST DIE INSTANZ SCHON EINGERICHTET? — beim Öffnen der Karte nachsehen
 * ===========================================================================
 *
 * Bis hierher wusste das CRM das nur aus dem nächtlichen Kennzahlenabruf. Eine
 * am Vormittag eingerichtete Instanz stand deshalb bis zum nächsten Morgen als
 * „noch nicht eingelöst" da, mit einem Knopf für einen Link, den die Instanz
 * längst sperrte.
 *
 * NUR, WENN ES ETWAS ZU KLÄREN GIBT. Gefragt wird ausschliesslich, solange die
 * Karte den Link nach bisherigem Stand anböte: Instanz aktiv, Geheimnis
 * vorhanden, kein Abschluss vermerkt, keine aktiven Personen gemeldet. Für
 * jede andere Instanz — also fast alle — geht keine Anfrage hinaus.
 *
 * NUR VORWÄRTS. Der Tag wird von `null` auf heute gesetzt, bedingt auf
 * `setupCompletedAt: null`, nie zurück. Zwei gleichzeitig geöffnete
 * Karten schreiben höchstens einmal.
 *
 * WIRFT NIE. Die Detailseite darf an dieser Nebensache nicht scheitern; ein
 * Ausfall heisst nur, dass die Karte den bisherigen Stand zeigt.
 */
@Injectable()
export class SetupStatusService {
  private readonly logger = new Logger(SetupStatusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly coolifyConfig: CoolifyConfigService,
    @Inject(SETUP_STATUS_FETCH) private readonly fetch: SetupStatusFetch,
  ) {}

  async check(companyId: string): Promise<void> {
    try {
      const instance = await this.prisma.instance.findUnique({
        where: { companyId },
        include: { metrics: { orderBy: { date: 'desc' }, take: 60 } },
      });
      if (instance === null) return;
      if (instance.setupCompletedAt !== null) return;

      const status = instance.status as InstanceStatus;
      const values =
        status === 'active' ? toMetrics(instance.metrics, today()) : null;
      const wouldBeOpen = invitationOpenFrom(
        status,
        values,
        instance.setupTokenEncrypted !== null,
        false,
      );
      if (!wouldBeOpen) return;

      const contract = this.coolifyConfig.contract();
      // Optionaler Endpunkt des Instanz-Vertrags: nicht deklariert = nicht fragen.
      if (contract.setupStatusPath === null) return;
      const state = await this.fetch(
        `https://${instanceHost(contract, instance.subdomain)}${contract.setupStatusPath}`,
        SETUP_STATUS_TIMEOUT_MS,
      );
      if (state !== 'configured') return;

      await this.prisma.instance.updateMany({
        where: { id: instance.id, setupCompletedAt: null },
        data: { setupCompletedAt: toDate(today()) },
      });
      this.logger.log(`${instance.subdomain} ist eingerichtet — vermerkt.`);
    } catch (error) {
      this.logger.warn(
        `Einrichtungsstand zu Organisation ${companyId} nicht geprüft: ` +
          `${error instanceof Error ? error.message : 'unbekannt'}.`,
      );
    }
  }
}
