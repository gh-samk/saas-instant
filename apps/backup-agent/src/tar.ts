// Minimaler ustar-Schreiber/-Leser (nur Dateien), damit das Rechnungsarchiv
// ohne zusaetzliche Abhaengigkeit entsteht.

function octal(n: number, len: number): Buffer {
  const b = Buffer.alloc(len, 0);
  b.write(n.toString(8).padStart(len - 1, '0'), 0, 'ascii');
  return b;
}

export function tarHeader(name: string, size: number, mtime: number): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  if (nameBuf.length > 100) throw new Error('Dateiname im Archiv zu lang');
  const h = Buffer.alloc(512, 0);
  nameBuf.copy(h, 0);
  octal(0o644, 8).copy(h, 100);
  octal(0, 8).copy(h, 108);
  octal(0, 8).copy(h, 116);
  octal(size, 12).copy(h, 124);
  octal(mtime, 12).copy(h, 136);
  h.fill(0x20, 148, 156);
  h.write('0', 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

export async function* tarStream(
  entries: AsyncIterable<{ name: string; data: Buffer }> | Iterable<{ name: string; data: Buffer }>,
  mtime = Math.floor(Date.now() / 1000),
): AsyncGenerator<Buffer> {
  for await (const e of entries) {
    yield tarHeader(e.name, e.data.length, mtime);
    yield e.data;
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad) yield Buffer.alloc(pad, 0);
  }
  yield Buffer.alloc(1024, 0);
}

export function parseTar(buf: Buffer): { name: string; data: Buffer }[] {
  const out: { name: string; data: Buffer }[] = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(h.subarray(124, 135).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8);
    off += 512;
    out.push({ name, data: Buffer.from(buf.subarray(off, off + size)) });
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}
