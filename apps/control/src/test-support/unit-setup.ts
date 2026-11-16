import { keyring } from '../crypto/keyring';

/**
 * Jest-Setup der Unit-Tests: ein fester Datenschlüssel NUR für Tests, damit
 * Dienste, die Blind-Indizes oder Feldverschlüsselung benutzen, ohne Datenbank
 * laufen (der Tresor selbst wird in `vault.service.spec.ts` geprüft).
 */
beforeEach(() => {
  keyring.set(Buffer.alloc(32, 7));
});
