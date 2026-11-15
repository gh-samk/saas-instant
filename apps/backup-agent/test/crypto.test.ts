import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { decryptBuffer, decryptStream, encryptBuffer, encryptStream, newKeyPair } from '../src/age.js';
import { deriveKey, open, seal } from '../src/state.js';
import { parseTar, tarStream } from '../src/tar.js';

async function collect(r: Readable): Promise<Buffer> {
  const c: Buffer[] = [];
  for await (const x of r) c.push(Buffer.from(x as Uint8Array));
  return Buffer.concat(c);
}

describe('age-Verschluesselung', () => {
  it('Roundtrip ueber Strom und Puffer', async () => {
    const kp = await newKeyPair();
    expect(kp.identity).toMatch(/^AGE-SECRET-KEY-1/);
    expect(kp.recipient).toMatch(/^age1/);
    const data = Buffer.alloc(300_000, 'abc');
    const enc = await collect(await encryptStream(kp.recipient, Readable.from([data])));
    expect(enc.includes(Buffer.from('abcabc'))).toBe(false);
    expect((await collect(await decryptStream(kp.identity, Readable.from([enc])))).equals(data)).toBe(true);
    expect((await decryptBuffer(kp.identity, await encryptBuffer(kp.recipient, data))).equals(data)).toBe(true);
  });

  it('falscher Schluessel scheitert, bevor Daten fliessen', async () => {
    const a = await newKeyPair();
    const b = await newKeyPair();
    const enc = await collect(await encryptStream(a.recipient, Readable.from([Buffer.from('geheim')])));
    await expect(decryptStream(b.identity, Readable.from([enc]))).rejects.toThrow();
  });
});

describe('Zustandsverschluesselung', () => {
  it('AES-256-GCM Roundtrip, Manipulation und falscher Schluessel werden erkannt', () => {
    const key = deriveKey('irgendein-langer-schluessel-0123456789abcdef');
    const blob = seal(key, Buffer.from('{"geheim":"wert"}'));
    expect(blob.includes(Buffer.from('geheim'))).toBe(false);
    expect(open(key, blob).toString()).toBe('{"geheim":"wert"}');
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => open(key, tampered)).toThrow();
    expect(() => open(deriveKey('anderer-schluessel-0123456789abcdef0123'), blob)).toThrow();
  });
});

describe('tar', () => {
  it('schreibt und liest Dateien', async () => {
    const parts: Buffer[] = [];
    for await (const c of tarStream([{ name: 'a/b.txt', data: Buffer.from('hallo') }, { name: 'c.bin', data: Buffer.alloc(1000, 7) }])) parts.push(c);
    const files = parseTar(Buffer.concat(parts));
    expect(files.map((f) => f.name)).toEqual(['a/b.txt', 'c.bin']);
    expect(files[0]!.data.toString()).toBe('hallo');
    expect(files[1]!.data.length).toBe(1000);
  });
});
