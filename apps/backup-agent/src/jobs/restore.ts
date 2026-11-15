import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { decryptStream } from '../age.js';
import type { ContainerRef } from '../docker/types.js';
import { kindOfKey, uploadsKeyFor } from '../keys.js';
import { safeMessage } from '../log.js';
import type { InstanceSpec, JobResult } from '../types.js';
import type { JobContext } from './context.js';
import { expectExit, readMeta, rmQuiet, tmpFile } from './common.js';

/** Laedt ein Chiffrat in eine Arbeitsdatei und prueft Groesse und SHA-256 gegen die Meta-Datei. */
async function download(ctx: JobContext, key: string, expected: { sizeBytes: number; sha256: string }): Promise<string> {
  const file = await tmpFile(ctx, '.age');
  try {
    const hash = createHash('sha256');
    let size = 0;
    const src = await ctx.storage.get(key);
    src.on('data', (c: Buffer) => {
      size += c.length;
      hash.update(c);
    });
    await pipeline(src, createWriteStream(file, { mode: 0o600 }));
    if (size !== expected.sizeBytes || hash.digest('hex') !== expected.sha256) {
      throw new Error('Heruntergeladene Datei stimmt nicht mit der Meta-Datei ueberein');
    }
    return file;
  } catch (e) {
    await rmQuiet(file);
    throw e;
  }
}

/**
 * Spielt eine Instanzsicherung in einen ANDEREN Compose-Stack ein.
 * Schutz: Ziel muss ein fremdes Projekt sein (nie Agent/Verwaltung); alle
 * Container-Zugriffe laufen nur ueber Container mit dem Projekt-Label des Ziels.
 * ageIdentity liegt nur im Arbeitsspeicher dieses Aufrufs.
 */
export async function runRestore(
  ctx: JobContext,
  args: { objectKey: string; ageIdentity: string; target: InstanceSpec },
): Promise<JobResult> {
  const { objectKey, ageIdentity, target } = args;
  if (kindOfKey(objectKey) !== 'instance') throw new Error('Nur Instanzsicherungen lassen sich wiederherstellen');
  if (ctx.keyPrefix && !objectKey.startsWith(ctx.keyPrefix)) throw new Error('Objektschluessel gehoert nicht zu diesem Ziel');

  // Fremder Stack? Wenn der eigene Stack nicht ermittelbar ist, wird abgelehnt (fail closed).
  const own = await ctx.ownProjects();
  if (own.size === 0) throw new Error('Eigener Compose-Stack nicht ermittelbar; Wiederherstellung abgelehnt');
  if (own.has(target.composeProject)) throw new Error('Ziel ist der eigene Stack des Agenten oder der Verwaltung; abgelehnt');

  const db = await ctx.docker.findContainer(target.composeProject, target.dbService);
  if (!db) throw new Error('Datenbank-Container im Ziel-Stack nicht gefunden');
  if (db.project !== target.composeProject || own.has(db.project)) throw new Error('Container gehoert nicht zum Ziel-Stack; abgelehnt');

  const meta = await readMeta(ctx, objectKey);
  if (!meta) throw new Error('Meta-Datei fehlt; Wiederherstellung abgelehnt');
  const dumpEntry = meta.files.find((f) => f.name === objectKey.split('/').pop());
  if (!dumpEntry) throw new Error('Sicherung steht nicht in der Meta-Datei');
  const upKey = uploadsKeyFor(objectKey);
  const upEntry = meta.files.find((f) => f.name === upKey.split('/').pop());
  const wantUploads = !!(target.uploadsService && target.uploadsPath && upEntry);

  const spool: string[] = [];
  const stopped: ContainerRef[] = [];
  let started = false;
  try {
    // Vorbereiten, ohne das Ziel anzufassen: laden, Pruefsumme, Schluessel testen.
    const dumpFile = await download(ctx, objectKey, dumpEntry);
    spool.push(dumpFile);
    const upFile = wantUploads ? await download(ctx, upKey, upEntry!) : undefined;
    if (upFile) spool.push(upFile);
    const plainDump = await decryptStream(ageIdentity, createReadStream(dumpFile)); // wirft bei falschem Schluessel

    // Ab hier wird das Ziel veraendert: App-Container des Ziel-Stacks anhalten (nicht die Datenbank).
    const project = await ctx.docker.listProject(target.composeProject);
    for (const c of project) {
      if (c.project !== target.composeProject || c.id === db.id || !c.running) continue;
      await ctx.docker.stop(c.id);
      stopped.push(c);
    }
    if (!(await ctx.docker.findContainer(target.composeProject, target.dbService))?.running) {
      await ctx.docker.start(db.id);
    }

    // --single-transaction: bei einem Fehler bleibt der alte Datenstand unveraendert.
    const restore = ctx.docker.exec(
      db.id,
      ['pg_restore', '--clean', '--if-exists', '--no-owner', '--single-transaction', '-U', target.dbUser, '-d', target.dbName],
      { stdin: plainDump },
    );
    restore.stdout.resume();
    await expectExit(ctx, restore, 'pg_restore');

    for (const c of stopped) await ctx.docker.start(c.id);
    started = true;

    if (upFile && target.uploadsService && target.uploadsPath) {
      const up = await ctx.docker.findContainer(target.composeProject, target.uploadsService);
      if (!up || up.project !== target.composeProject) throw new Error('Container fuer die Uploads im Ziel-Stack nicht gefunden');
      const plainUp = await decryptStream(ageIdentity, createReadStream(upFile));
      const tar = ctx.docker.exec(up.id, ['tar', 'xzf', '-', '-C', target.uploadsPath], { stdin: plainUp });
      tar.stdout.resume();
      await expectExit(ctx, tar, 'tar (Uploads)');
    }
    return { objectKey };
  } finally {
    if (!started) {
      // Fehlerfall: vorher laufende Container wieder starten, damit das Ziel nicht still stehen bleibt.
      for (const c of stopped) {
        await ctx.docker.start(c.id).catch((e: unknown) => {
          ctx.log.warn('Container konnte nicht wieder gestartet werden', { error: safeMessage(ctx.redactor, e) });
        });
      }
    }
    for (const f of spool) await rmQuiet(f);
  }
}
