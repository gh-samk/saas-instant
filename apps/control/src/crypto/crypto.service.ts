import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'crypto';

/** Fester Salt: der Schlüssel muss über Neustarts hinweg stabil bleiben. */
const SALT = 'saas-instant-control-crypto-salt';

/**
 * Anwendungsseitige Verschlüsselung ruhender Geheimnisse (AES-256-GCM):
 * TOTP-Geheimnis der Benutzer und später der Kennzahlen-Token je Instanz.
 *
 * Der Schlüssel wird aus `CONTROL_CONFIG_KEY` abgeleitet. Es gibt bewusst
 * KEINEN Entwicklungs-Fallback: ein fehlender Schlüssel lässt die Anwendung
 * beim Start scheitern, statt still mit einem bekannten Wert zu verschlüsseln.
 */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const secret = config.get<string>('CONTROL_CONFIG_KEY');
    if (!secret || secret.trim().length < 32) {
      throw new Error(
        'CONTROL_CONFIG_KEY fehlt oder ist kürzer als 32 Zeichen. ' +
          'Ohne diesen Schlüssel lassen sich TOTP-Geheimnisse nicht sicher ' +
          'ablegen — die Verwaltung startet daher nicht.',
      );
    }
    this.key = scryptSync(secret, SALT, 32);
  }

  /** Verschlüsselt Klartext zu `iv.tag.ciphertext` (jeweils base64). */
  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
  }

  /**
   * Entschlüsselt einen zuvor gespeicherten Wert. Wirft bei falschem Schlüssel
   * oder manipuliertem Wert — kein stiller `null`-Rückgabewert, weil ein nicht
   * lesbares TOTP-Geheimnis sonst als „kein TOTP eingerichtet" durchginge.
   */
  decrypt(stored: string): string {
    const parts = stored.split('.');
    if (parts.length !== 3) {
      throw new Error('Verschlüsselter Wert hat ein unbekanntes Format.');
    }
    const [ivB64, tagB64, ctB64] = parts;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}
