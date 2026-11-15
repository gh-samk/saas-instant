import { Controller, Get } from '@nestjs/common';
import { ManifestService } from './manifest.service';

export interface PublicConfiguration {
  productName: string;
  logoUrl: string | null;
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
    const { productName, logoUrl } = this.manifest.ui;
    return { productName, logoUrl };
  }
}
