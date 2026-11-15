import { createHash } from 'node:crypto';
import { setBase } from '../keys.js';
import type { JobResult } from '../types.js';
import type { JobContext } from './context.js';
import { readMeta } from './common.js';

/** Prueft Groesse und SHA-256 des Chiffrats gegen die Meta-Datei. Es wird NICHT entschluesselt. */
export async function runVerify(ctx: JobContext, objectKey: string): Promise<JobResult> {
  if (ctx.keyPrefix && !objectKey.startsWith(ctx.keyPrefix)) throw new Error('Objektschluessel gehoert nicht zu diesem Ziel');
  if (setBase(objectKey) === objectKey || objectKey.endsWith('.meta.json')) throw new Error('Objektschluessel ist keine Sicherungsdatei');
  const head = await ctx.storage.head(objectKey);
  if (!head) throw new Error('Sicherungsdatei nicht gefunden');
  const meta = await readMeta(ctx, objectKey);
  if (!meta) throw new Error('Meta-Datei fehlt oder ist unlesbar');
  const name = objectKey.split('/').pop()!;
  const entry = meta.files.find((f) => f.name === name);
  if (!entry) throw new Error('Datei steht nicht in der Meta-Datei');

  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of await ctx.storage.get(objectKey)) {
    const b = Buffer.from(chunk as Uint8Array);
    size += b.length;
    hash.update(b);
  }
  const sha256 = hash.digest('hex');
  if (size !== entry.sizeBytes || head.size !== entry.sizeBytes) throw new Error('Groesse weicht von der Meta-Datei ab');
  if (sha256 !== entry.sha256) throw new Error('Pruefsumme weicht von der Meta-Datei ab');
  return { objectKey, sizeBytes: size, sha256 };
}
