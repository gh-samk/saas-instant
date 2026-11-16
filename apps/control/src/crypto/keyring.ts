import { hkdfSync } from 'crypto';

/** Wird geworfen, solange der Tresor gesperrt ist (kein Datenschlüssel im Speicher). */
export class VaultLockedError extends Error {
  constructor() {
    super('Der Tresor ist gesperrt.');
    this.name = 'VaultLockedError';
  }
}

const HKDF_SALT = Buffer.from('saas-instant/vault/v1');
const INFO_ENC = 'saas-instant/field-encryption/enc-key/v1';
const INFO_INDEX = 'saas-instant/field-encryption/index-key/v1';

/**
 * Hält die aus dem Datenschlüssel (DEK) abgeleiteten Schlüssel NUR im
 * Prozessspeicher. Beim Prozessende ist alles weg; ein Neustart startet
 * gesperrt. Prozessweit genau eine Instanz: die Feldverschlüsselung ist eine
 * Eigenschaft der Datenbank, nicht eines einzelnen Dienstes.
 */
class Keyring {
  private encKey: Buffer | null = null;
  private indexKey: Buffer | null = null;

  get unlocked(): boolean {
    return this.encKey !== null;
  }

  /** Leitet `encKey` und `indexKey` per HKDF aus dem DEK ab. Der DEK selbst wird nicht behalten. */
  set(dek: Buffer): void {
    if (dek.length !== 32) {
      throw new Error('Der Datenschlüssel muss 32 Byte lang sein.');
    }
    this.encKey = Buffer.from(hkdfSync('sha256', dek, HKDF_SALT, INFO_ENC, 32));
    this.indexKey = Buffer.from(
      hkdfSync('sha256', dek, HKDF_SALT, INFO_INDEX, 32),
    );
  }

  clear(): void {
    this.encKey?.fill(0);
    this.indexKey?.fill(0);
    this.encKey = null;
    this.indexKey = null;
  }

  enc(): Buffer {
    if (!this.encKey) throw new VaultLockedError();
    return this.encKey;
  }

  index(): Buffer {
    if (!this.indexKey) throw new VaultLockedError();
    return this.indexKey;
  }
}

export const keyring = new Keyring();
