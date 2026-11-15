import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';

/** Zaehlt Bytes und bildet SHA-256 im Durchlauf. */
export function meter(): { stream: Transform; stats: () => { size: number; sha256: string } } {
  const hash = createHash('sha256');
  let size = 0;
  let digest: string | undefined;
  const stream = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  return {
    stream,
    stats: () => {
      digest ??= hash.digest('hex');
      return { size, sha256: digest };
    },
  };
}
