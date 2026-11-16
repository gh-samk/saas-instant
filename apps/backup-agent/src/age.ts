import { Readable } from 'node:stream';
import { Decrypter, Encrypter, generateIdentity, identityToRecipient } from 'age-encryption';

type WebStream = ReadableStream<Uint8Array>;

export async function newKeyPair(): Promise<{ identity: string; recipient: string }> {
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  return { identity, recipient };
}

export async function encryptStream(recipient: string, src: Readable): Promise<Readable> {
  const enc = new Encrypter();
  enc.addRecipient(recipient);
  const out = await enc.encrypt(Readable.toWeb(src) as unknown as WebStream);
  return Readable.fromWeb(out as never);
}

/** Der Kopf wird vor der Rueckgabe geprueft: falscher Schluessel wirft hier, nicht erst beim Lesen. */
export async function decryptStream(identity: string, src: Readable): Promise<Readable> {
  const dec = new Decrypter();
  dec.addIdentity(identity);
  const out = await dec.decrypt(Readable.toWeb(src) as unknown as WebStream);
  return Readable.fromWeb(out as never);
}

export async function encryptBuffer(recipient: string, data: Buffer): Promise<Buffer> {
  const enc = new Encrypter();
  enc.addRecipient(recipient);
  return Buffer.from(await enc.encrypt(data));
}

export async function decryptBuffer(identity: string, data: Buffer): Promise<Buffer> {
  const dec = new Decrypter();
  dec.addIdentity(identity);
  return Buffer.from(await dec.decrypt(data));
}

/** Oeffentlicher Schluessel (Empfaenger) zu einem privaten age-Schluessel. */
export async function recipientOf(identity: string): Promise<string> {
  return identityToRecipient(identity);
}
