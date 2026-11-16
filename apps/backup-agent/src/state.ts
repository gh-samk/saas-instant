import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TargetState } from './types.js';

const MAGIC = Buffer.from('SIAS1');

/** Schluessel aus AGENT_STATE_KEY: 64 Hex-Zeichen direkt, sonst SHA-256 des Textes. */
export function deriveKey(raw: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return createHash('sha256').update(raw).digest();
}

export function seal(key: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
}

export function open(key: Buffer, blob: Buffer): Buffer {
  if (blob.length < MAGIC.length + 28 || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Zustandsdatei ist ungueltig');
  }
  const iv = blob.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = blob.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(blob.subarray(MAGIC.length + 28)), d.final()]);
  } catch {
    throw new Error('Zustandsdatei laesst sich nicht entschluesseln (falscher AGENT_STATE_KEY?)');
  }
}

/** Verschluesselter Zustand im State-Volume. Der private age-Schluessel gehoert nie hierher. */
export class StateStore {
  private readonly file: string;
  private readonly key: Buffer;

  constructor(dir: string, rawKey: string) {
    this.file = path.join(dir, 'target.enc');
    this.key = deriveKey(rawKey);
  }

  async load(): Promise<TargetState | null> {
    let blob: Buffer;
    try {
      blob = await fs.readFile(this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    return JSON.parse(open(this.key, blob).toString('utf8')) as TargetState;
  }

  async save(state: TargetState): Promise<void> {
    await this.write(this.file, state);
  }

  /**
   * Weitere Zustandsdateien (zuletzt gueltiger Plan, nachzureichende Meldungen):
   * gleiche Verschluesselung wie das Ziel, eigener Dateiname.
   */
  async loadAux<T>(name: string): Promise<T | null> {
    let blob: Buffer;
    try {
      blob = await fs.readFile(this.auxFile(name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    return JSON.parse(open(this.key, blob).toString('utf8')) as T;
  }

  async saveAux(name: string, value: unknown): Promise<void> {
    await this.write(this.auxFile(name), value);
  }

  private auxFile(name: string): string {
    if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error('Ungueltiger Name der Zustandsdatei');
    return path.join(path.dirname(this.file), `${name}.enc`);
  }

  private async write(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, seal(this.key, Buffer.from(JSON.stringify(value), 'utf8')), { mode: 0o600 });
    await fs.rename(tmp, file);
  }
}
