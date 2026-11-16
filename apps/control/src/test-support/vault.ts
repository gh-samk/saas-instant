import { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { VaultService } from '../vault/vault.service';

/** Feste Passphrase NUR für Test-Datenbanken. Nie für eine echte Installation verwenden. */
export const TEST_VAULT_PASSPHRASE = 'test-tresor-passphrase-nur-fuer-tests';

const TEST_ACTOR = { userId: null, actor: 'test' } as const;

/** Günstige Ableitung für Tests (siehe `VaultService.useKdfParamsForTests`). */
const CHEAP_KDF = { memoryKib: 8 * 1024, timeCost: 1, parallelism: 1 } as const;

/**
 * Richtet den Tresor mit der festen Test-Passphrase ein, falls die Datenbank
 * noch keinen hat, und entsperrt ihn. Idempotent: eine bereits eingerichtete
 * Test-Datenbank wird nur entsperrt. Gibt den Dienst zurück (z. B. für `lock()`).
 */
export async function unlockTestVault(
  prisma: PrismaService,
  passphrase = TEST_VAULT_PASSPHRASE,
): Promise<VaultService> {
  const vault = new VaultService(prisma, new AuditService(prisma));
  vault.useKdfParamsForTests(CHEAP_KDF);
  if (await vault.isInitialized()) {
    await vault.unlock(passphrase, TEST_ACTOR, 'test');
  } else {
    await vault.initialize(passphrase, TEST_ACTOR);
  }
  return vault;
}
