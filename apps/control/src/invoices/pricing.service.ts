import { Injectable } from '@nestjs/common';
import { datePlusDays, dateStringFromDate, today, toDate } from '@saas-instant/shared';
import { PILOT_TO_PAYING_AFTER_DAYS } from '../companies/deadlines';
import { CompanyNotFoundError } from '../companies/company.errors';
import { PrismaService } from '../prisma/prisma.service';
import { PricingConfigService } from './pricing.config';
import { averageActivePersons, tierFor } from './pricing.tier';
import type { PriceSuggestion, SuggestionBlocker } from './pricing.types';

/**
 * Der Stufenvorschlag — R5 in Reinform: er wird ANGEZEIGT, nicht vollzogen.
 *
 * Es gibt in diesem Dienst keinen Schreibvorgang. `Organisation.preisstufe`
 * setzt ausschließlich die Betreiberin von Hand über den bestehenden
 * `OrganisationController`. Diese Trennung ist der Grund, warum die
 * Aufgabenquelle `preisangabe_fehlt` aus Etappe 2 auch nach Etappe 4 noch
 * trägt: Sie meldet Piloten ohne Preisvereinbarung, und Etappe 4 hat nichts
 * hinzugefügt, was diese Vereinbarung von selbst herstellte.
 */
@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly coolifyConfig: PricingConfigService,
  ) {}

  /**
   * Vorschlag für eine Organisation, gerechnet auf den DURCHSCHNITT der
   * aktiven Personen über die letzten 90 Tage vor dem Stichtag.
   *
   * Der Auftrag nennt den Grund für den Durchschnitt statt eines Stichwerts
   * selbst: „damit niemand wegen einer einzelnen Woche über die Schwelle
   * kippt". Die Zeitreihe kommt aus `Kennzahl` (Etappe 3).
   *
   * `stichtag` ist ausdrücklich ein Parameter und nicht `heute()`: Eine
   * Rechnung wird gelegentlich rückwirkend geschrieben, und dann muss die
   * Grundlage der Zeitraum VOR dem Rechnungsdatum sein, nicht vor dem Tag des
   * Tippens.
   */
  async suggestion(
    companyId: string,
    cutoffDate: string = today(),
  ): Promise<PriceSuggestion> {
    const table = this.coolifyConfig.read();
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        customAmount: true,
        priceTier: true,
        paymentInterval: true,
        instanceStartDate: true,
        instance: { select: { id: true } },
      },
    });
    if (!company) throw new CompanyNotFoundError();

    // Der Zeitraum endet AM Stichtag und umfasst `averageDays` Tage.
    const from = datePlusDays(cutoffDate, -(table.averageDays - 1));
    const period = { from, until: cutoffDate };

    const blockers: SuggestionBlocker[] = [];
    let measurements: (number | null)[] = [];

    if (company.instance === null) {
      blockers.push('no_instance');
    } else {
      const rows = await this.prisma.metric.findMany({
        where: {
          instanceId: company.instance.id,
          date: { gte: toDate(from), lte: toDate(cutoffDate) },
          // Gescheiterte Abfragen haben keine Zahlen und dürfen den
          // Durchschnitt nicht nach unten ziehen (siehe `pricing.tier.ts`).
          fetchSuccessful: true,
        },
        select: { activePersons: true },
      });
      measurements = rows.map((z) => z.activePersons);
    }

    const { average, measurementDays } = averageActivePersons(measurements);
    if (average === null && company.instance !== null) {
      blockers.push('no_metrics');
    }

    const subscriptionCalculableFrom =
      company.instanceStartDate === null
        ? null
        : datePlusDays(
            dateStringFromDate(company.instanceStartDate),
            PILOT_TO_PAYING_AFTER_DAYS,
          );
    // PILOTLOGIK: Die Einrichtung ist mit dem Aufsetzen der Instanz erbracht
    // und sofort berechenbar. Das Abo beginnt erst nach der Pilotphase.
    const subscriptionCalculable =
      subscriptionCalculableFrom !== null && cutoffDate >= subscriptionCalculableFrom;
    if (subscriptionCalculableFrom !== null && !subscriptionCalculable) {
      blockers.push('instance_too_young');
    }

    return {
      tier: average === null ? null : tierFor(average, table.tiers),
      blockers,
      averageActivePersons:
        average === null ? null : Math.round(average * 10) / 10,
      measurementDays,
      period,
      // Als ZEICHENKETTE, wie überall in diesem Projekt: ein Decimal(10,2)
      // durch `number` zu schicken hieße Geldbeträge über Gleitkomma reichen.
      customAmount: company.customAmount?.toFixed(2) ?? null,
      subscriptionCalculableFrom,
      subscriptionCalculable,
      setupCalculable: true,
      // Nur gelesen, nie gesetzt (R5): Der Vertrag steht, wie die Betreiberin
      // ihn eingetragen hat. `tier()` kennt auch archivierte Stufen — ein
      // Vertrag darf eine ältere Stufe weiterführen.
      contract: {
        tierKey: company.priceTier,
        tier: this.coolifyConfig.tier(company.priceTier),
        paymentInterval: company.paymentInterval,
      },
    };
  }
}
