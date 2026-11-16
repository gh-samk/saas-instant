import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { encryptStream } from '../age.js';
import { meter } from '../meter.js';
import { metaKeyFor } from '../keys.js';
import type { ExecHandle } from '../docker/types.js';
import type { BackupMeta } from '../types.js';
import type { JobContext } from './context.js';
import { isRecord } from '../validate.js';
import { sha256hex } from '../hmac.js';

export interface Spooled {
  file: string;
  size: number;
  sha256: string;
}

export async function tmpFile(ctx: JobContext, suffix: string): Promise<string> {
  await fs.mkdir(ctx.workDir, { recursive: true, mode: 0o700 });
  return path.join(ctx.workDir, `${randomBytes(8).toString('hex')}${suffix}`);
}

export async function rmQuiet(file: string | undefined): Promise<void> {
  if (file) await fs.rm(file, { force: true }).catch(() => undefined);
}

/** Verschluesselt einen Klartext-Strom nach `file` und misst Groesse und SHA-256 des Chiffrats. */
export async function encryptToFile(ctx: JobContext, plain: Readable, file: string): Promise<Spooled> {
  const enc = await encryptStream(ctx.recipient, plain);
  const m = meter();
  await pipeline(enc, m.stream, createWriteStream(file, { mode: 0o600 }), ctx.signal ? { signal: ctx.signal } : {});
  return { file, ...m.stats() };
}

/** Wartet auf das Ende eines Exec-Laufs und wirft bei Exit-Code != 0 (Text ohne Geheimnisse). */
export async function expectExit(ctx: JobContext, h: ExecHandle, what: string): Promise<void> {
  const r = await h.done;
  if (r.exitCode !== 0) {
    throw new Error(`${what} fehlgeschlagen (Exit ${r.exitCode}): ${ctx.redactor.string(r.stderr).slice(0, 300)}`);
  }
}

export async function putFile(ctx: JobContext, key: string, file: string, retainUntil?: Date): Promise<void> {
  await ctx.storage.put(key, createReadStream(file), retainUntil ? { retainUntil } : undefined);
}

export async function putMeta(ctx: JobContext, objectKey: string, meta: BackupMeta, retainUntil?: Date): Promise<void> {
  await ctx.storage.put(metaKeyFor(objectKey), Buffer.from(JSON.stringify(meta, null, 2)), retainUntil ? { retainUntil } : undefined);
}

export async function readAll(stream: Readable, max = 10 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of stream) {
    const b = Buffer.from(c as Uint8Array);
    n += b.length;
    if (n > max) throw new Error('Datei ist zu gross');
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

export async function readMeta(ctx: JobContext, objectKey: string): Promise<BackupMeta | null> {
  const key = metaKeyFor(objectKey);
  if (!(await ctx.storage.head(key))) return null;
  const buf = await readAll(await ctx.storage.get(key), 1024 * 1024);
  try {
    const v: unknown = JSON.parse(buf.toString('utf8'));
    if (!isRecord(v) || !Array.isArray(v['files'])) return null;
    return v as unknown as BackupMeta;
  } catch {
    return null;
  }
}

export function digestOf(text: string): string {
  return sha256hex(text);
}
