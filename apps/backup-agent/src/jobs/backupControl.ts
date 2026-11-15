import { Readable } from 'node:stream';
import { dateOfKey, stamp } from '../keys.js';
import { safeMessage } from '../log.js';
import { tarStream } from '../tar.js';
import type { BackupMeta, JobResult } from '../types.js';
import type { JobContext } from './context.js';
import { digestOf, encryptToFile, expectExit, putFile, putMeta, readMeta, rmQuiet, tmpFile } from './common.js';
import { sha256hex } from '../hmac.js';
import { pruneOldBackups } from './retention.js';

/** Verwaltungs-DB und Rechnungsarchiv. Das Rechnungsarchiv wird nie geloescht und (S3) mit Object Lock versehen. */
export async function runBackupControl(ctx: JobContext): Promise<JobResult> {
  const ts = stamp(ctx.now());
  const dumpKey = `${ctx.keyPrefix}control/${ts}.dump.age`;
  const spool: string[] = [];
  let result: JobResult;

  try {
    const file = await tmpFile(ctx, '.dump.age');
    spool.push(file);
    const dump = ctx.controlDump();
    const s = await encryptToFile(ctx, dump.stdout, file);
    await expectExit(ctx, dump, 'pg_dump der Verwaltung');
    await putFile(ctx, dumpKey, file);
    const meta: BackupMeta = {
      version: 1,
      kind: 'control',
      createdAt: ctx.now().toISOString(),
      files: [{ name: dumpKey.split('/').pop()!, sizeBytes: s.size, sha256: s.sha256 }],
    };
    await putMeta(ctx, dumpKey, meta);
    result = { objectKey: dumpKey, sizeBytes: s.size, sha256: s.sha256 };
    await report(ctx, 'control', dumpKey, s.size, s.sha256);
    try {
      await pruneOldBackups(ctx, 'control/');
    } catch (e) {
      ctx.log.warn('Aufraeumen fehlgeschlagen', { error: safeMessage(ctx.redactor, e) });
    }
  } finally {
    for (const f of spool) await rmQuiet(f);
  }

  // Rechnungsarchiv je Jahr. Fehler hier lassen den Lauf scheitern (Meldung),
  // die Datenbanksicherung oben bleibt trotzdem erhalten.
  await archiveInvoices(ctx);
  return result;
}

async function report(ctx: JobContext, kind: 'control' | 'invoices', key: string, size: number, sha: string) {
  try {
    await ctx.control.report({ kind, date: dateOfKey(key)!, sizeBytes: size, objectKey: key, sha256: sha });
  } catch (e) {
    ctx.log.warn('Meldung an die Verwaltung fehlgeschlagen', { error: safeMessage(ctx.redactor, e) });
  }
}

async function archiveInvoices(ctx: JobContext): Promise<void> {
  const src = ctx.invoices();
  const retainUntil = ctx.target.objectLock
    ? new Date(ctx.now().getTime() + ctx.invoiceRetentionYears * 365.25 * 86_400_000)
    : undefined;

  for (const year of await src.years()) {
    // Eintraege einsammeln; Hashliste bestimmt den Inhalt (und damit, ob sich etwas geaendert hat).
    const entries: { name: string; data: Buffer }[] = [];
    const hashLines: string[] = [];
    for await (const inv of src.ofYear(year)) {
      const safe = inv.number.replace(/[^A-Za-z0-9._-]/g, '_');
      const add = (suffix: string, data?: Buffer | null) => {
        if (!data || data.length === 0) return;
        const name = `invoices/${year}/${safe}${suffix}`;
        entries.push({ name, data });
        hashLines.push(`${sha256hex(data)}  ${name}`);
      };
      add('.pdf', inv.pdf);
      add('.xml', inv.xml);
      add('-xrechnung.xml', inv.xrechnung);
    }
    if (entries.length === 0) continue;
    const hashes = hashLines.join('\n') + '\n';
    const contentDigest = digestOf(hashes);

    // Unveraenderte Jahre nicht erneut ablegen (gesperrte Objekte wuerden sich sonst anhaeufen).
    const existing = (await ctx.storage.list(`${ctx.keyPrefix}invoices/${year}/`))
      .filter((o) => o.key.endsWith('.tar.age'))
      .map((o) => o.key)
      .sort();
    const latest = existing[existing.length - 1];
    if (latest) {
      const m = await readMeta(ctx, latest);
      if (m?.contentDigest === contentDigest) continue;
    }

    const key = `${ctx.keyPrefix}invoices/${year}/${stamp(ctx.now())}.tar.age`;
    const file = await tmpFile(ctx, '.tar.age');
    try {
      const plain = Readable.from(tarStream([...entries, { name: 'hashes.sha256', data: Buffer.from(hashes) }]));
      const s = await encryptToFile(ctx, plain, file);
      await putFile(ctx, key, file, retainUntil);
      await putMeta(
        ctx,
        key,
        {
          version: 1,
          kind: 'invoices',
          createdAt: ctx.now().toISOString(),
          year,
          contentDigest,
          files: [{ name: key.split('/').pop()!, sizeBytes: s.size, sha256: s.sha256 }],
        },
        retainUntil,
      );
      await report(ctx, 'invoices', key, s.size, s.sha256);
    } finally {
      await rmQuiet(file);
    }
  }
}
