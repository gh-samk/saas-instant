import { Controller, Get } from '@nestjs/common';
import { ManifestService } from './manifest.service';

export interface PublicConfiguration {
  productName: string;
  logoUrl: string | null;
  /** True, sobald die Verwaltung an eine Software angebunden ist (Name + Slug im Manifest). */
  bound: boolean;
}

/**
 * Öffentliche Konfiguration für die Oberfläche. BEWUSST ohne Sitzung (die
 * Anmeldeseite braucht Name und Logo) und BEWUSST nur der UI-Teil des
 * Manifests: Mail-, Abrechnungs- und Provisionierungsdaten verlassen den
 * Server nie über diesen Weg.
 */
@Controller('public-config')
export class PublicConfigController {
  constructor(private readonly manifest: ManifestService) {}

  @Get()
  read(): PublicConfiguration {
    return {
      productName: this.manifest.displayName,
      logoUrl: this.manifest.ui.logoUrl,
      bound: this.manifest.bound,
    };
  }
}
