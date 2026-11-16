import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'crypto';
import { VaultLockedError, keyring } from './keyring';

/**
 * Feldverschlüsselung (AES-256-GCM) für Kundendaten in der Datenbank.
 *
 * FORMAT
 *   Text:   `enc:v1:` + base64(iv | tag | ciphertext)
 *   Bytes:  `ENC1` + iv | tag | ciphertext
 *   Json:   das gesamte JSON als String verschlüsselt (Textformat), gespeichert
 *           als JSON-String.
 *
 * AAD = `Modell.Feld.id`. Damit lässt sich ein Chiffretext nicht in einen
 * anderen Datensatz oder ein anderes Feld kopieren: die Entschlüsselung scheitert.
 *
 * ALTDATEN: Werte OHNE Präfix gelten als Klartext und werden unverändert
 * geliefert (Zeilen aus der Zeit vor der Verschlüsselung).
 */

const TEXT_PREFIX = 'enc:v1:';
const BYTES_HEADER = Buffer.from('ENC1', 'ascii');
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Ein gespeicherter Wert lässt sich nicht entschlüsseln: der GCM-Prüfwert
 * stimmt nicht (Chiffretext verändert, in einen anderen Datensatz oder ein
 * anderes Feld kopiert, anderer Schlüssel) oder der Wert ist abgeschnitten.
 *
 * Eigener Fehlertyp mit Modell, Feld und Zeilen-Kennung, damit Aufrufer, die
 * Manipulation als BEFUND melden müssen (Integritätslauf, Archiv), sie von
 * einem gesperrten Tresor (`VaultLockedError`) und von Programmfehlern
 * unterscheiden können. Die Meldung enthält nie Klar- oder Chiffretext.
 */
export class FieldDecryptError extends Error {
  constructor(
    readonly model: string,
    readonly field: string,
    readonly id: string,
  ) {
    super(
      `${model}.${field} (id ${id}) lässt sich nicht entschlüsseln: ` +
        'Wert verändert oder falscher Schlüssel.',
    );
    this.name = 'FieldDecryptError';
  }
}

/** Zerlegt `Modell.Feld.id` (die id darf selbst Punkte enthalten). */
function parseAad(aad: string): { model: string; field: string; id: string } {
  const first = aad.indexOf('.');
  const second = first < 0 ? -1 : aad.indexOf('.', first + 1);
  if (first < 0 || second < 0) return { model: aad, field: '?', id: '?' };
  return {
    model: aad.slice(0, first),
    field: aad.slice(first + 1, second),
    id: aad.slice(second + 1),
  };
}

/** Führt `work` aus und macht aus jedem Entschlüsselungsfehler einen `FieldDecryptError`. */
function decryptOrThrow<T>(aad: string, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof VaultLockedError) throw error;
    const { model, field, id } = parseAad(aad);
    throw new FieldDecryptError(model, field, id);
  }
}

/**
 * Wie streng Werte OHNE Chiffre-Präfix (Klartext) beim Lesen behandelt werden.
 *
 * Zunächst (`strict = false`) gelten sie als Altdaten aus der Zeit vor der
 * Verschlüsselung und kommen unverändert zurück. Sobald der Einmal-Lauf
 * `encrypt-existing` nach dem Entsperren durch ist, ist alles Veränderbare
 * verschlüsselt; ab dann ist ein Klartext im verschlüsselten Feld ein Befund
 * (jemand hat per SQL einen Wert untergeschoben, Downgrade), kein Altbestand.
 * Ausgenommen bleiben die dokumentierten Altbereiche, siehe
 * `isLegacyPlaintextAllowed` in `prisma/field-encryption.ts`.
 *
 * Der Zustand lebt nur im Prozess: nach einem Neustart ist der Tresor gesperrt,
 * und der Lauf setzt ihn beim nächsten Entsperren wieder.
 */
export const plaintextPolicy = { strict: false };

export function aadFor(model: string, field: string, id: string): string {
  return `${model}.${field}.${id}`;
}

export function isEncryptedText(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(TEXT_PREFIX);
}

export function isEncryptedBytes(value: unknown): boolean {
  return (
    value instanceof Uint8Array &&
    value.length >= BYTES_HEADER.length + IV_LENGTH + TAG_LENGTH &&
    Buffer.from(value.subarray(0, BYTES_HEADER.length)).equals(BYTES_HEADER)
  );
}

function seal(plain: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', keyring.enc(), iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function open(blob: Buffer, aad: string): Buffer {
  if (blob.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Verschlüsselter Wert ist zu kurz.');
  }
  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ct = blob.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', keyring.enc(), iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function encryptField(value: string, aad: string): string {
  return TEXT_PREFIX + seal(Buffer.from(value, 'utf8'), aad).toString('base64');
}

/** Entschlüsselt `enc:v1:`-Werte; Klartext (ohne Präfix) kommt unverändert zurück. */
export function decryptField(stored: string, aad: string): string {
  if (!isEncryptedText(stored)) return stored;
  return decryptOrThrow(aad, () => {
    const blob = Buffer.from(stored.slice(TEXT_PREFIX.length), 'base64');
    return open(blob, aad).toString('utf8');
  });
}

export function encryptBytes(value: Uint8Array, aad: string): Buffer {
  return Buffer.concat([BYTES_HEADER, seal(Buffer.from(value), aad)]);
}

export function decryptBytes(stored: Uint8Array, aad: string): Buffer {
  if (!isEncryptedBytes(stored)) return Buffer.from(stored);
  return decryptOrThrow(aad, () =>
    open(Buffer.from(stored.subarray(BYTES_HEADER.length)), aad),
  );
}

/** Das gesamte JSON als String verschlüsselt; gespeichert wird ein JSON-String. */
export function encryptJson(value: unknown, aad: string): string {
  return encryptField(JSON.stringify(value), aad);
}

export function decryptJson(stored: unknown, aad: string): unknown {
  if (!isEncryptedText(stored)) return stored;
  const text = decryptField(stored, aad);
  return decryptOrThrow(aad, () => JSON.parse(text) as unknown);
}

/** Normalisierung für Blind-Indizes: Leerraum, Groß-/Kleinschreibung, Unicode-Form. */
export function normalizeForIndex(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

/**
 * Blind-Index: HMAC-SHA256 über `feld:normalisierterWert` mit dem Indexschlüssel.
 * Deterministisch (gleiche Eingabe, gleicher Wert), aber ohne den Schlüssel nicht
 * umkehrbar und nicht zwischen Feldern vergleichbar.
 */
export function blindIndex(value: string, field: string): string {
  return createHmac('sha256', keyring.index())
    .update(`${field}:${normalizeForIndex(value)}`, 'utf8')
    .digest('hex');
}

/** Blind-Index der Einwilligungs-Adresse (`Consent.emailIdx`), für eindeutige Abfragen. */
export const consentEmailIndex = (email: string): string =>
  blindIndex(email, 'Consent.email');

/** Blind-Index der Kontaktadresse einer Organisation (`Company.contactEmailIdx`). */
export const companyContactEmailIndex = (email: string): string =>
  blindIndex(email, 'Company.contactEmail');

/** Blind-Index einer Empfängeradresse im Postausgang (`MailDelivery.recipientIdx`). */
export const mailRecipientIndex = (email: string): string =>
  blindIndex(email, 'MailDelivery.recipient');
