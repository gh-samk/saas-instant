import { Controller, Get, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AllowWhileLocked } from '../vault/allow-while-locked.decorator';
import { authModeFrom, envFrom } from '../sso/sso-settings';
import type { AuthMode } from '../sso/sso-settings';
import { IssuerProfileService } from '../settings/issuer-profile.service';
import { ManifestService } from './manifest.service';

export interface PublicConfiguration {
  productName: string;
  logoUrl: string | null;
  /** True, sobald die Verwaltung an eine Software angebunden ist (Name + Slug im Manifest). */
  bound: boolean;
  /** Akzentfarbe der Firmendaten (`#rrggbb`) oder null. */
  accentColor: string | null;
  /** Für den Dunkelmodus aufgehellte Akzentfarbe oder null. */
  accentOnDark: string | null;
  /** Ein Logo liegt unter `GET /api/public/logo`. */
  hasLogo: boolean;
  /** Betriebsart der Anmeldung: `single` (lokal) oder `portal` (SSO). */
  authMode: AuthMode;
}

/**
 * Öffentliche Konfiguration für die Oberfläche. BEWUSST ohne Sitzung (die
 * Anmeldeseite braucht Name und Logo) und BEWUSST nur der UI-Teil des
 * Manifests: Mail-, Abrechnungs- und Provisionierungsdaten verlassen den
 * Server nie über diesen Weg.
 */
@AllowWhileLocked(
  'Die Anmeldeseite braucht Name, Logo-Hinweis und Anmeldeart vor dem Entsperren; ' +
    'gelesen werden nur Manifest und Einstellungen, keine verschlüsselten Felder.',
)
@Controller('public-config')
export class PublicConfigController {
  constructor(
    private readonly manifest: ManifestService,
    @Optional() private readonly issuer?: IssuerProfileService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  @Get()
  async read(): Promise<PublicConfiguration> {
    const branding = (await this.issuer?.branding()) ?? {
      accentColor: null,
      accentOnDark: null,
      hasLogo: false,
    };
    return {
      productName: this.manifest.displayName,
      logoUrl: this.manifest.ui.logoUrl,
      bound: this.manifest.bound,
      ...branding,
      authMode: this.config ? authModeFrom(envFrom(this.config)) : 'single',
    };
  }
}
