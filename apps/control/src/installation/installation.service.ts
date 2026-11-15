import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ManifestService } from '../manifest/manifest.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Prüft, ob der Slug aus der Umgebung (`SAAS_INSTANT_SLUG`, vom Compose an
 * den Container gereicht) zum Slug des Manifests passt. Ohne gesetzte Variable
 * gibt es nichts zu prüfen. Wirft bei Abweichung (Start abbrechen).
 */
export function assertEnvSlugMatches(
  envSlug: string | undefined,
  manifestSlug: string,
): void {
  const env = (envSlug ?? '').trim();
  if (env === '' || env === manifestSlug) return;
  throw new Error(
    `Slug passt nicht: SAAS_INSTANT_SLUG ist "${env}", das Manifest (product.slug) sagt "${manifestSlug}". ` +
      'Eine Verwaltung gehört zu genau einer Software - Manifest oder Umgebung korrigieren, ' +
      'nicht beides vermischen. Start abgebrochen.',
  );
}

/**
 * Bindet die Verwaltung an genau eine Software: Der erste Start schreibt den
 * `product.slug` in die Singleton-Tabelle `Installation`; jeder spätere Start
 * mit anderem Slug bricht ab (lieber nicht starten, als Daten zweier
 * Produkte in einer Datenbank zu mischen). Gleicher Slug aktualisiert nur den
 * Anzeigenamen.
 */
@Injectable()
export class InstallationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(InstallationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly manifest: ManifestService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bind();
  }

  async bind(): Promise<void> {
    const slug = this.manifest.product.slug;
    const name = this.manifest.product.name;
    assertEnvSlugMatches(process.env['SAAS_INSTANT_SLUG'], slug);

    // Singleton ohne Wettlauf: parallele Erststarts legen höchstens einmal an.
    await this.prisma.installation.createMany({
      data: [{ id: 'singleton', slug, productName: name }],
      skipDuplicates: true,
    });
    const row = await this.prisma.installation.findUnique({
      where: { id: 'singleton' },
    });
    if (!row) {
      throw new Error('Installation konnte nicht gelesen werden (Tabelle "Installation").');
    }
    if (row.slug !== slug) {
      throw new Error(
        `Diese Verwaltung ist an die Software "${row.slug}" gebunden, das Manifest nennt aber "${slug}". ` +
          'Eine Verwaltung gehört zu genau einer Software. Entweder das Manifest (product.slug) ' +
          'zurücksetzen oder eine eigene Verwaltung mit eigener Datenbank für die andere Software ' +
          'einrichten. Start abgebrochen.',
      );
    }
    if (row.productName !== name) {
      await this.prisma.installation.update({
        where: { id: 'singleton' },
        data: { productName: name },
      });
    }
    this.logger.log(`Verwaltung gebunden an Software "${slug}".`);
  }
}
