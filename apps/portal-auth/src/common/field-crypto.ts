import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';

/**
 * AES-256-GCM mit einem aus PORTAL_KEY_SECRET abgeleiteten Schlüssel.
 * Schützt die privaten Signaturschlüssel und die TOTP-Geheimnisse in der DB.
 * Format: `v1.<iv>.<tag>.<chiffrat>` (base64url).
 */
export class FieldCrypto {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = Buffer.from(
      hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), 'portal-auth/field-key/v1', 32),
    );
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt(value: string): string {
    const [version, iv, tag, ct] = value.split('.');
    if (version !== 'v1' || !iv || !tag || !ct) throw new Error('Unbekanntes Format des verschlüsselten Werts.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }
}
