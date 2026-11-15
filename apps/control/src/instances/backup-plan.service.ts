import { Injectable } from '@nestjs/common';
import type { AgentInstance } from '../backup-settings/backup-agent.types';
import { ManifestService } from '../manifest/manifest.service';
import { DEFAULT_RETENTION_YEARS } from '../manifest/sections/billing';
import { PrismaService } from '../prisma/prisma.service';
import { agentInstanceFor } from './backup-plan';

export interface BackupPlanResponse {
  retentionYears: number;
  instances: AgentInstance[];
}

/**
 * Der Sicherungsplan für den Agent: welche Instanzen er sichern soll und wo
 * ihre Daten liegen. Nur LESEND; ohne Geheimnisse.
 */
@Injectable()
export class BackupPlanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly manifest: ManifestService,
  ) {}

  /**
   * Aufbewahrungsfrist der Rechnungen in Jahren (Manifest `billing.retentionYears`,
   * Standard 8). Der Agent richtet die Aufbewahrung des Rechnungsarchivs danach.
   */
  retentionYears(): number {
    const years = this.manifest.billing.retentionYears;
    return typeof years === 'number' && Number.isInteger(years) && years >= 1
      ? years
      : DEFAULT_RETENTION_YEARS;
  }

  /** Die Antwort von `GET /api/internal/backup-plan`. */
  async response(): Promise<BackupPlanResponse> {
    return { retentionYears: this.retentionYears(), instances: await this.plan() };
  }

  async plan(): Promise<AgentInstance[]> {
    const backup = this.manifest.provisioning.backup;
    // Ohne Abschnitt im Manifest weiß niemand, wo die Daten liegen: leerer Plan.
    if (backup === null) return [];
    const instances = await this.prisma.instance.findMany({
      where: { status: 'active' },
      orderBy: { subdomain: 'asc' },
      select: { subdomain: true, coolifyApplicationId: true },
    });
    return instances
      .map((instance) => agentInstanceFor(backup, instance))
      .filter((entry): entry is AgentInstance => entry !== null);
  }
}
