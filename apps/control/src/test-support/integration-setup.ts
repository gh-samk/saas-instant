import { prisma } from './company-provisioning';
import { unlockTestVault } from './vault';

/**
 * Jest-Setup der Integrationstests: richtet den Tresor der Test-Datenbank mit der
 * festen Test-Passphrase ein und entsperrt ihn, bevor die erste Suite läuft.
 * Ohne das lieferte jeder Schreibzugriff auf verschlüsselte Felder einen Fehler.
 */
beforeAll(async () => {
  await unlockTestVault(prisma);
}, 120_000);
