import { Global, Module } from '@nestjs/common';
import { ISSUER_PROFILE_SOURCE } from '../invoices/document/issuer.config';
import { IssuerProfileService } from './issuer-profile.service';

/**
 * Das Firmenprofil (global): Rechnungen, Aufnahmeformular und öffentliche
 * Konfiguration lesen es über `IssuerConfigService.current()` bzw. direkt.
 */
@Global()
@Module({
  providers: [
    IssuerProfileService,
    { provide: ISSUER_PROFILE_SOURCE, useExisting: IssuerProfileService },
  ],
  exports: [IssuerProfileService, ISSUER_PROFILE_SOURCE],
})
export class IssuerProfileModule {}
