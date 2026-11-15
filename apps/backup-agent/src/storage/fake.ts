import { Readable } from 'node:stream';
import type { ObjectInfo, PutOptions, Storage } from './types.js';

/** Speicher im Arbeitsspeicher fuer Tests. Bildet Object Lock nach: gesperrte Objekte lassen sich nicht loeschen. */
export class FakeStorage implements Storage {
  readonly objects = new Map<string, { data: Buffer; retainUntil?: Date; modified: Date }>();
  readonly deleted: string[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  async put(key: string, body: Readable | Buffer, opts?: PutOptions): Promise<void> {
    let data: Buffer;
    if (Buffer.isBuffer(body)) data = body;
    else {
      const chunks: Buffer[] = [];
      for await (const c of body) chunks.push(Buffer.from(c as Uint8Array));
      data = Buffer.concat(chunks);
    }
    this.objects.set(key, { data, retainUntil: opts?.retainUntil, modified: this.now() });
  }

  async get(key: string): Promise<Readable> {
    const o = this.objects.get(key);
    if (!o) throw new Error('Objekt nicht gefunden');
    return Readable.from([o.data]);
  }

  async list(prefix: string): Promise<ObjectInfo[]> {
    return [...this.objects.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, o]) => ({ key, size: o.data.length, lastModified: o.modified }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const o = this.objects.get(key);
    return o ? { key, size: o.data.length, lastModified: o.modified } : null;
  }

  async delete(key: string): Promise<void> {
    const o = this.objects.get(key);
    if (!o) return;
    if (o.retainUntil && o.retainUntil > this.now()) throw new Error('Object Lock: Aufbewahrung laeuft noch');
    this.deleted.push(key);
    this.objects.delete(key);
  }
}
