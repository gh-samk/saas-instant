import { randomBytes } from 'crypto';
import {
  aadFor,
  blindIndex,
  decryptBytes,
  decryptField,
  decryptJson,
  encryptBytes,
  encryptField,
  encryptJson,
  isEncryptedBytes,
  isEncryptedText,
} from './field-crypto';
import { VaultLockedError, keyring } from './keyring';

describe('field-crypto', () => {
  beforeEach(() => keyring.set(randomBytes(32)));
  afterEach(() => keyring.clear());

  const aad = aadFor('Company', 'name', 'id-1');

  describe('Text', () => {
    it('Roundtrip, Format enc:v1:<base64(iv|tag|ct)>', () => {
      const stored = encryptField('Musterverein e. V.', aad);
      expect(stored.startsWith('enc:v1:')).toBe(true);
      expect(isEncryptedText(stored)).toBe(true);
      const blob = Buffer.from(stored.slice('enc:v1:'.length), 'base64');
      expect(blob.length).toBe(12 + 16 + Buffer.byteLength('Musterverein e. V.'));
      expect(stored).not.toContain('Musterverein');
      expect(decryptField(stored, aad)).toBe('Musterverein e. V.');
    });

    it('verschlüsselt auch den leeren String und Umlaute', () => {
      expect(decryptField(encryptField('', aad), aad)).toBe('');
      expect(decryptField(encryptField('Äöü ß 日本', aad), aad)).toBe('Äöü ß 日本');
    });

    it('gleicher Klartext ergibt jedes Mal einen anderen Chiffretext (zufälliger IV)', () => {
      expect(encryptField('x', aad)).not.toBe(encryptField('x', aad));
    });

    it('falsche AAD (anderer Datensatz, anderes Feld) scheitert', () => {
      const stored = encryptField('geheim', aad);
      expect(() => decryptField(stored, aadFor('Company', 'name', 'id-2'))).toThrow();
      expect(() => decryptField(stored, aadFor('Company', 'city', 'id-1'))).toThrow();
      expect(() => decryptField(stored, aadFor('Note', 'name', 'id-1'))).toThrow();
    });

    it('Manipulation (ein Bit im Chiffretext, im Tag, im IV) scheitert', () => {
      const stored = encryptField('geheim', aad);
      const blob = Buffer.from(stored.slice('enc:v1:'.length), 'base64');
      for (const position of [0, 12, blob.length - 1]) {
        const tampered = Buffer.from(blob);
        tampered[position] ^= 1;
        expect(() =>
          decryptField(`enc:v1:${tampered.toString('base64')}`, aad),
        ).toThrow();
      }
    });

    it('Wert ohne Präfix gilt als Altdaten-Klartext und kommt unverändert zurück', () => {
      expect(decryptField('Klartext von früher', aad)).toBe('Klartext von früher');
    });

    it('ein anderer Schlüssel (anderer Tresor) kann nicht entschlüsseln', () => {
      const stored = encryptField('geheim', aad);
      keyring.set(randomBytes(32));
      expect(() => decryptField(stored, aad)).toThrow();
    });

    it('bei gesperrtem Tresor wirft Verschlüsseln und Entschlüsseln VaultLockedError', () => {
      const stored = encryptField('geheim', aad);
      keyring.clear();
      expect(() => encryptField('x', aad)).toThrow(VaultLockedError);
      expect(() => decryptField(stored, aad)).toThrow(VaultLockedError);
      // Klartext braucht keinen Schlüssel.
      expect(decryptField('alt', aad)).toBe('alt');
    });
  });

  describe('Bytes', () => {
    it('Roundtrip mit Präfix-Header ENC1', () => {
      const pdf = Buffer.from('%PDF-1.7 \u0000\u0001 binär');
      const stored = encryptBytes(pdf, aad);
      expect(stored.subarray(0, 4).toString('ascii')).toBe('ENC1');
      expect(isEncryptedBytes(stored)).toBe(true);
      expect(stored.includes(Buffer.from('%PDF'))).toBe(false);
      expect(decryptBytes(stored, aad).equals(pdf)).toBe(true);
    });

    it('Klartext-Bytes (Altdaten) kommen unverändert zurück; falsche AAD und Manipulation scheitern', () => {
      const plain = Buffer.from('<?xml version="1.0"?>');
      expect(isEncryptedBytes(plain)).toBe(false);
      expect(decryptBytes(plain, aad).equals(plain)).toBe(true);
      const stored = encryptBytes(plain, aad);
      expect(() => decryptBytes(stored, aadFor('Invoice', 'xmlContent', 'x'))).toThrow();
      const tampered = Buffer.from(stored);
      tampered[tampered.length - 1] ^= 1;
      expect(() => decryptBytes(tampered, aad)).toThrow();
    });
  });

  describe('Json', () => {
    it('speichert das gesamte JSON als verschlüsselten String', () => {
      const value = { logo: 'x', lines: ['a', 'b'], n: 3, nested: { ok: true } };
      const stored = encryptJson(value, aad);
      expect(typeof stored).toBe('string');
      expect(stored).not.toContain('logo');
      expect(decryptJson(stored, aad)).toEqual(value);
    });

    it('Alt-JSON (Objekt ohne Präfix) kommt unverändert zurück; falsche AAD scheitert', () => {
      const legacy = { a: 1 };
      expect(decryptJson(legacy, aad)).toBe(legacy);
      expect(() => decryptJson(encryptJson({ a: 1 }, aad), aadFor('AuditLog', 'afterValue', 'z'))).toThrow();
    });
  });

  describe('Blind-Index', () => {
    it('ist stabil und normalisiert (Groß-/Kleinschreibung, Leerraum)', () => {
      const a = blindIndex('Anna@Example.com', 'Consent.email');
      expect(a).toMatch(/^[0-9a-f]{64}$/);
      expect(blindIndex('  anna@example.com ', 'Consent.email')).toBe(a);
      expect(blindIndex('anna@example.com', 'Consent.email')).toBe(a);
    });

    it('unterscheidet Werte und Felder', () => {
      const a = blindIndex('anna@example.com', 'Consent.email');
      expect(blindIndex('bernd@example.com', 'Consent.email')).not.toBe(a);
      expect(blindIndex('anna@example.com', 'Company.contactEmail')).not.toBe(a);
    });

    it('hängt am Schlüssel des Tresors', () => {
      const dek = randomBytes(32);
      keyring.set(dek);
      const a = blindIndex('anna@example.com', 'Consent.email');
      keyring.set(dek);
      expect(blindIndex('anna@example.com', 'Consent.email')).toBe(a);
      keyring.set(randomBytes(32));
      expect(blindIndex('anna@example.com', 'Consent.email')).not.toBe(a);
    });

    it('enthält den Klartext nicht und verlangt entsperrten Tresor', () => {
      expect(blindIndex('anna@example.com', 'x')).not.toContain('anna');
      keyring.clear();
      expect(() => blindIndex('anna@example.com', 'x')).toThrow(VaultLockedError);
    });
  });
});
