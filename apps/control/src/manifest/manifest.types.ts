import type { BillingManifest } from './sections/billing';
import type { MailManifest } from './sections/mail';
import type { ProductManifest } from './sections/product';
import type { ProvisioningManifest } from './sections/provisioning';
import type { UiManifest } from './sections/ui';

export interface Manifest {
  product: ProductManifest;
  mail: MailManifest;
  billing: BillingManifest;
  provisioning: ProvisioningManifest;
  ui: UiManifest;
}

export class ManifestError extends Error {
  constructor(
    public readonly source: string,
    public readonly error: string[],
  ) {
    super(`Ungültiges Manifest (${source}):\n - ${error.join('\n - ')}`);
    this.name = 'ManifestError';
  }
}
