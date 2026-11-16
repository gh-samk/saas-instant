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
export async function runBackupControl(ctx: JobContext, opts: { invoicesOnly?: boolean } = {}): Promise<JobResult> {
  if (opts.invoicesOnly) {
    await archiveInvoices(ctx);
    return {};
  }
  const ts = stamp(ctx.now());
  const dumpKey = `${ctx.keyPrefix}control/${ts}.dump.age`;
  const spool: string[] = [];
  let result: JobResult;

  try {
    const file = await tmpFile(ctx, '.dump.age');
    spool.push(file);
    const dump = ctx.controlDump(ctx.signal);
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

  // Rechnungsarchiv je Jahr. Fehler hier lassen den Lauf scheitern (Meldung), die Datenbanksicherung
  // oben bleibt trotzdem erhalten. Ist die Verwaltung gesperrt (423), wird der Lauf als "deferred" gemeldet.
  await archiveInvoices(ctx);
  return result;
}

async function report(ctx: JobContext, kind: 'control' | 'invoices', key: string | undefined, size: number, sha: string | undefined, runDate = false) {
  try {
    await ctx.control.report({
      kind,
      // Bei einem Lauf ohne neue Dateien zaehlt das Datum des Laufs, nicht das des alten Archivs.
      date: (!runDate && key ? dateOfKey(key) : null) ?? ctx.now().toISOString().slice(0, 10),
      sizeBytes: size,
      ...(key ? { objectKey: key } : {}),
      ...(sha ? { sha256: sha } : {}),
    });
  } catch (e) {
    ctx.log.warn('Meldung an die Verwaltung fehlgeschlagen', { error: safeMessage(ctx.redactor, e) });
  }
}

async function archiveInvoices(ctx: JobContext): Promise<void> {
  const src = ctx.invoices();
  const retainUntil = ctx.target.objectLock
    ? new Date(ctx.now().getTime() + ctx.invoiceRetentionYears * 365.25 * 86_400_000)
    : undefined;

  const all = await src.fetchAll();
  let reported = false;
  // Neuestes bereits vorhandenes Archiv (fuer die Meldung eines Laufs ohne neue Dateien).
  let latestExisting: { key: string; size: number; sha: string } | undefined;
  for (const year of [...all.keys()].sort()) {
    // Eintraege einsammeln; Hashliste bestimmt den Inhalt (und damit, ob sich etwas geaendert hat).
    const entries: { name: string; data: Buffer }[] = [];
    const hashLines: string[] = [];
    const usedBases = new Set<string>();
    for (const inv of all.get(year) ?? []) {
      let safe = inv.number.replace(/[^A-Za-z0-9._-]/g, '_');
      // "RE/2026/1" und "RE_2026_1" ergaeben denselben Dateinamen; die zweite Rechnung wuerde im Archiv
      // verschwinden. Die Reihenfolge ist stabil (nach Nummer sortiert), der Inhalt bleibt reproduzierbar.
      for (let n = 2; usedBases.has(safe.toLowerCase()); n++) safe = `${inv.number.replace(/[^A-Za-z0-9._-]/g, '_')}__${n}`;
      usedBases.add(safe.toLowerCase());
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
      if (m?.contentDigest === contentDigest) {
        const f = m.files[0];
        if (f && (!latestExisting || latest > latestExisting.key)) latestExisting = { key: latest, size: f.sizeBytes, sha: f.sha256 };
        continue;
      }
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
      reported = true;
    } finally {
      await rmQuiet(file);
    }
  }
  // Ein gelungener Lauf ohne neue Dateien ist trotzdem ein Lauf: ohne Meldung schluege die Aufgabe
  // "Sicherung der Verwaltung ueberfaellig" bei einem unveraenderten Archiv (oder ganz ohne Rechnungen)
  // dauerhaft an. Gemeldet wird das neueste vorhandene Archiv bzw. ein leerer Lauf.
  // Hat die Verwaltung Belege uebersprungen, ist das Archiv UNVOLLSTAENDIG: Lauf als fehlgeschlagen
  // verbuchen (keine Meldung "gelungen"); beim naechsten Lauf werden sie erneut angefragt, und ein
  // geaendertes Archiv wird dann neu abgelegt (der Inhaltsvergleich erkennt es).
  const skipped = src.skipped?.() ?? [];
  if (skipped.length > 0) {
    const list = skipped.slice(0, 10).map((x) => `${x.number} (${x.reason})`).join(', ');
    ctx.log.error('Rechnungsarchiv unvollstaendig: Belege von der Verwaltung uebersprungen', { anzahl: skipped.length, belege: list });
    throw new Error(`Rechnungsarchiv unvollstaendig: ${skipped.length} Beleg(e) nicht abrufbar (${list}); neuer Versuch beim naechsten Lauf`);
  }
  if (!reported) await report(ctx, 'invoices', latestExisting?.key, latestExisting?.size ?? 0, latestExisting?.sha, true);
}
