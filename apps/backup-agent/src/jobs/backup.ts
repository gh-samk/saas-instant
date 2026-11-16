import { dateOfKey, stamp } from '../keys.js';
import { safeMessage } from '../log.js';
import type { BackupMeta, InstanceSpec, JobResult } from '../types.js';
import type { JobContext } from './context.js';
import { encryptToFile, expectExit, putFile, putMeta, rmQuiet, tmpFile } from './common.js';
import { pruneOldBackups } from './retention.js';

/** Sicherung einer Instanz: pg_dump (und optional Uploads) per Exec, verschluesselt, hochgeladen, gemeldet. */
export async function runBackup(ctx: JobContext, spec: InstanceSpec): Promise<JobResult> {
  const db = await ctx.docker.findContainer(spec.composeProject, spec.dbService);
  if (!db) throw new Error('Datenbank-Container der Instanz nicht gefunden');
  if (!db.running) throw new Error('Datenbank-Container der Instanz laeuft nicht');

  const ts = stamp(ctx.now());
  const base = `${ctx.keyPrefix}instances/${spec.subdomain}/${ts}`;
  const dumpKey = `${base}.dump.age`;
  const uploadsKey = `${base}.uploads.tar.age`;
  const files: BackupMeta['files'] = [];
  const written: string[] = [];
  const spool: string[] = [];

  try {
    // 1) Datenbank
    const dumpFile = await tmpFile(ctx, '.dump.age');
    spool.push(dumpFile);
    const dump = ctx.docker.exec(db.id, ['pg_dump', '-Fc', '-U', spec.dbUser, spec.dbName], { signal: ctx.signal });
    const dumpSpool = await encryptToFile(ctx, dump.stdout, dumpFile);
    await expectExit(ctx, dump, 'pg_dump');
    await putFile(ctx, dumpKey, dumpFile);
    written.push(dumpKey);
    files.push({ name: dumpKey.split('/').pop()!, sizeBytes: dumpSpool.size, sha256: dumpSpool.sha256 });

    // 2) Uploads (falls konfiguriert). Scheitert nur dieser Teil (z. B. tar), bleibt der bereits
    //    hochgeladene Datenbank-Dump erhalten: ein halber Satz ist besser als keiner. Der Lauf gilt
    //    trotzdem als gescheitert (siehe unten), damit die fehlenden Uploads sichtbar bleiben.
    let total = dumpSpool.size;
    let uploadsError: unknown;
    if (spec.uploadsService && spec.uploadsPath) {
      try {
        const up = await ctx.docker.findContainer(spec.composeProject, spec.uploadsService);
        if (!up || !up.running) throw new Error('Container fuer die Uploads nicht gefunden oder nicht gestartet');
        const upFile = await tmpFile(ctx, '.uploads.tar.age');
        spool.push(upFile);
        const tar = ctx.docker.exec(up.id, ['tar', 'czf', '-', '-C', spec.uploadsPath, '.'], { signal: ctx.signal });
        const upSpool = await encryptToFile(ctx, tar.stdout, upFile);
        await expectExit(ctx, tar, 'tar');
        await putFile(ctx, uploadsKey, upFile);
        written.push(uploadsKey);
        files.push({ name: uploadsKey.split('/').pop()!, sizeBytes: upSpool.size, sha256: upSpool.sha256 });
        total += upSpool.size;
      } catch (e) {
        if (ctx.signal?.aborted) throw e; // Zeitlimit: kein Teilerfolg, der aeussere Pfad raeumt auf
        uploadsError = e;
        await ctx.storage.delete(uploadsKey).catch(() => undefined); // halb hochgeladenes Objekt nicht liegen lassen
      }
    }

    const meta: BackupMeta = {
      version: 1,
      kind: 'instance',
      subdomain: spec.subdomain,
      createdAt: ctx.now().toISOString(),
      files,
      ...(uploadsError !== undefined ? { partial: true } : {}),
    };
    await putMeta(ctx, dumpKey, meta);

    const result: JobResult = { objectKey: dumpKey, sizeBytes: total, sha256: files[0]!.sha256 };
    try {
      await ctx.control.report({
        subdomain: spec.subdomain,
        kind: 'instance',
        date: dateOfKey(dumpKey)!,
        sizeBytes: total,
        objectKey: dumpKey,
        sha256: result.sha256!,
        ...(files[1] ? { uploadsSha256: files[1].sha256 } : {}),
      });
    } catch (e) {
      ctx.log.warn('Meldung an die Verwaltung fehlgeschlagen', { error: safeMessage(ctx.redactor, e) });
    }
    if (uploadsError !== undefined) {
      // Kein Aufraeumen: sonst verdraengt der unvollstaendige Satz mit der Zeit vollstaendige.
      written.length = 0; // der Dump bleibt; der aeussere Fehlerpfad darf ihn nicht entfernen
      throw new Error(
        `Teilweise gescheitert: Datenbank-Dump gesichert (${dumpKey}), Uploads NICHT: ${safeMessage(ctx.redactor, uploadsError)}`,
      );
    }
    try {
      await pruneOldBackups(ctx, `instances/${spec.subdomain}/`);
    } catch (e) {
      ctx.log.warn('Aufraeumen fehlgeschlagen', { error: safeMessage(ctx.redactor, e) });
    }
    return result;
  } catch (e) {
    // Unvollstaendigen Satz wieder entfernen (nur eigene, gerade geschriebene Dateien; nie invoices/*).
    for (const k of written) await ctx.storage.delete(k).catch(() => undefined);
    throw e;
  } finally {
    for (const f of spool) await rmQuiet(f);
  }
}
