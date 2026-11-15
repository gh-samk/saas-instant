import { Injectable, Logger } from '@nestjs/common';
import { loadManifest, MANIFEST_PATH_PRESET } from './manifest.loader';
import type { Manifest } from './manifest.types';
import type { BillingManifest } from './sections/billing';
import type { MailManifest } from './sections/mail';
import { isBound, PRODUCT_PRESET, type ProductManifest } from './sections/product';
import type { ProvisioningManifest } from './sections/provisioning';
import type { UiManifest } from './sections/ui';

/**
 * Hält das Manifest (Produktname, Mail, Abrechnung, Provisionierung, UI).
 * Geladen wird EINMAL beim Erzeugen aus MANIFEST_PFAD; ein ungültiges Manifest
 * lässt den Start scheitern, ein fehlendes führt zu neutralen Vorgaben + Warnung.
 */
@Injectable()
export class ManifestService {
  private readonly logger = new Logger(ManifestService.name);
  private readonly manifest: Manifest;
  readonly loadedFrom: string | null;

  constructor() {
    const path = process.env['MANIFEST_PATH'] || MANIFEST_PATH_PRESET;
    const result = loadManifest(path);
    this.manifest = result.manifest;
    this.loadedFrom = result.loadedFrom;
    if (result.loadedFrom === null) {
      this.logger.warn(
        `Manifest-Datei "${path}" nicht gefunden - neutrale Vorgaben aktiv. ` +
          'Pfad per MANIFEST_PATH setzen (Vorlage: saas-instant.manifest.example.yaml).',
      );
    } else {
      this.logger.log(`Manifest geladen aus "${path}".`);
    }
  }

  get all(): Manifest {
    return this.manifest;
  }
  get product(): ProductManifest {
    return this.manifest.product;
  }
  get mail(): MailManifest {
    return this.manifest.mail;
  }
  get billing(): BillingManifest {
    return this.manifest.billing;
  }
  get provisioning(): ProvisioningManifest {
    return this.manifest.provisioning;
  }
  get ui(): UiManifest {
    return this.manifest.ui;
  }

  /** True, sobald das Manifest eine Software benennt (Name weicht vom Preset ab, Slug gesetzt). */
  get bound(): boolean {
    return isBound(this.manifest.product);
  }
  /**
   * Anzeigename der Oberfläche: bis zur Anbindung der Preset-Name, danach
   * `ui.productName` (Override) oder `product.name`.
   */
  get displayName(): string {
    if (!this.bound) return PRODUCT_PRESET.name;
    return this.manifest.ui.productName ?? this.manifest.product.name;
  }
}
