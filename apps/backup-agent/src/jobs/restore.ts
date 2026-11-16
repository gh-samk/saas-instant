import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { decryptStream, recipientOf } from '../age.js';
import type { ContainerRef } from '../docker/types.js';
import { kindOfKey, uploadsKeyFor } from '../keys.js';
import { safeMessage } from '../log.js';
import type { InstanceSpec, JobResult } from '../types.js';
import type { JobContext } from './context.js';
import { expectExit, readAll, readMeta, rmQuiet, tmpFile } from './common.js';

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
    await pipeline(src, createWriteStream(file, { mode: 0o600 }), ctx.signal ? { signal: ctx.signal } : {});
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
 * Projekte, die nie Ziel einer Wiederherstellung sind: die Verwaltungen dieser Software (install.sh benennt
 * sie `saas-instant-<slug>`), das Portal und der Anmeldedienst portal-auth (`saas-instant-portal`).
 * Ein `*` am Ende steht fuer einen Praefix. Der Betreiber ergaenzt ueber RESTORE_DENY_PROJECTS.
 */
export const DEFAULT_DENIED_PROJECTS = ['saas-instant-*'];

export function isDeniedProject(project: string, list: string[]): boolean {
  const p = project.toLowerCase();
  return list.some((entry) => {
    const e = entry.toLowerCase();
    return e.endsWith('*') ? p.startsWith(e.slice(0, -1)) : p === e;
  });
}

/** Nutzerobjekte: Tabellen, Views, Sequenzen usw. ausserhalb der Systemschemas, ohne Erweiterungsobjekte. */
const USER_OBJECTS_SQL =
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
  "WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%' " +
  "AND c.relkind IN ('r','p','v','m','S','f') " +
  "AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')";

async function assertTargetEmpty(ctx: JobContext, dbId: string, target: InstanceSpec): Promise<void> {
  const q = ctx.docker.exec(dbId, ['psql', '-U', target.dbUser, '-d', target.dbName, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', USER_OBJECTS_SQL], {
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const out = (await readAll(q.stdout, 1024)).toString('utf8').trim();
  await expectExit(ctx, q, 'psql (Pruefung der Ziel-Datenbank)');
  if (!/^\d+$/.test(out)) throw new Error('Ziel-Datenbank konnte nicht geprueft werden; Wiederherstellung abgelehnt');
  if (Number(out) > 0) throw new Error('Ziel-Datenbank ist nicht leer; es wird nur in eine leere Datenbank wiederhergestellt; abgelehnt');
}

/**
 * Spielt eine Instanzsicherung in einen ANDEREN Compose-Stack ein.
 * Schutz (der Agent vertraut dem HMAC-Aufrufer nicht blind):
 *  - der age-Schluessel muss zu DIESEM Ziel gehoeren (Empfaenger stimmt), sonst koennte jemand
 *    mit eigenem Schluessel und eigenem Speicher beliebige Daten einspielen;
 *  - das Ziel muss ein NEUER Stack sein: nicht der eigene Stack, nicht auf der Sperrliste und nicht
 *    im aktuellen Sicherungsplan (= laufende Instanz); zusaetzlich muss die Ziel-Datenbank LEER sein
 *    (keine Nutzerobjekte), sonst wird vor jeder Aenderung abgebrochen: vorhandene Daten werden nie ueberschrieben;
 *  - die SHA-256 der Sicherung kommt von der Verwaltung und wird vor dem Entschluesseln geprueft;
 *    die Meta-Datei im selben Speicher allein beweist nichts;
 *    dasselbe gilt fuer das Uploads-Archiv (Backup.uploadsSha256): Hat die Verwaltung eine, muss sie zum Archiv
 *    passen, sonst Abbruch. Hat sie keine (Altbestand oder Sicherung ohne Uploads), wird ein im Speicher liegendes
 *    Uploads-Archiv NICHT eingespielt (nur die Datenbank) und das im Job-Ergebnis und Log gemeldet;
 *  - alle Container-Zugriffe laufen nur ueber Container mit dem Projekt-Label des Ziels.
 * ageIdentity liegt nur im Arbeitsspeicher dieses Aufrufs.
 */
export async function runRestore(
  ctx: JobContext,
  args: { objectKey: string; ageIdentity: string; target: InstanceSpec; expectedSha256: string; expectedUploadsSha256?: string },
): Promise<JobResult> {
  const { objectKey, ageIdentity, target, expectedSha256, expectedUploadsSha256 } = args;
  if (kindOfKey(objectKey) !== 'instance') throw new Error('Nur Instanzsicherungen lassen sich wiederherstellen');
  if (ctx.keyPrefix && !objectKey.startsWith(ctx.keyPrefix)) throw new Error('Objektschluessel gehoert nicht zu diesem Ziel');

  if ((await recipientOf(ageIdentity)) !== ctx.recipient) {
    throw new Error('Der age-Schluessel gehoert nicht zu diesem Sicherungsziel; Wiederherstellung abgelehnt');
  }

  // Fremder Stack? Wenn der eigene Stack nicht ermittelbar ist, wird abgelehnt (fail closed).
  const own = await ctx.ownProjects();
  if (own.size === 0) throw new Error('Eigener Compose-Stack nicht ermittelbar; Wiederherstellung abgelehnt');
  if (own.has(target.composeProject)) throw new Error('Ziel ist der eigene Stack des Agenten oder der Verwaltung; abgelehnt');

  if (isDeniedProject(target.composeProject, ctx.deniedProjects)) {
    throw new Error('Ziel liegt auf der Sperrliste (Verwaltung, Portal oder Anmeldedienst); abgelehnt');
  }
  // Laufende Instanz? Der Plan der Verwaltung (bei gesperrter Verwaltung der gemerkte) nennt alle.
  let plan;
  try {
    plan = await ctx.control.getPlan();
  } catch {
    throw new Error('Sicherungsplan nicht verfuegbar; ob das Ziel eine laufende Instanz ist, laesst sich nicht pruefen; Wiederherstellung abgelehnt');
  }
  if (plan.instances.some((i) => i.composeProject.toLowerCase() === target.composeProject.toLowerCase())) {
    throw new Error('Ziel ist eine laufende Instanz laut Sicherungsplan; es wird nur in NEUE Stacks wiederhergestellt; abgelehnt');
  }

  const db = await ctx.docker.findContainer(target.composeProject, target.dbService);
  if (!db) throw new Error('Datenbank-Container im Ziel-Stack nicht gefunden');
  if (db.project !== target.composeProject || own.has(db.project)) throw new Error('Container gehoert nicht zum Ziel-Stack; abgelehnt');

  const meta = await readMeta(ctx, objectKey);
  if (!meta) throw new Error('Meta-Datei fehlt; Wiederherstellung abgelehnt');
  const dumpEntry = meta.files.find((f) => f.name === objectKey.split('/').pop());
  if (!dumpEntry) throw new Error('Sicherung steht nicht in der Meta-Datei');
  // Echtheit: die Pruefsumme, die die Verwaltung bei der Sicherung gemeldet hat, muss mit dem Eintrag
  // in der Meta-Datei uebereinstimmen. Wer nur den Speicher beschreiben kann, kann beides nicht angleichen.
  if (dumpEntry.sha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error('Pruefsumme der Sicherung weicht von der Angabe der Verwaltung ab; Wiederherstellung abgelehnt');
  }
  const upKey = uploadsKeyFor(objectKey);
  const upEntry = meta.files.find((f) => f.name === upKey.split('/').pop());
  let note: string | undefined;
  if (expectedUploadsSha256 !== undefined) {
    // Die Verwaltung kennt das Uploads-Archiv: es muss im Speicher stehen und zur gemeldeten Pruefsumme passen.
    if (!upEntry || upEntry.sha256.toLowerCase() !== expectedUploadsSha256.toLowerCase()) {
      throw new Error('Pruefsumme der Uploads weicht von der Angabe der Verwaltung ab; Wiederherstellung abgelehnt');
    }
  } else if (upEntry) {
    note = 'Uploads NICHT eingespielt: die Verwaltung hat keine Pruefsumme dafuer (Altbestand); nur die Datenbank wurde wiederhergestellt';
    ctx.log.warn(note, { objectKey });
  }
  const wantUploads = !!(target.uploadsService && target.uploadsPath && upEntry && expectedUploadsSha256 !== undefined);

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

    // Ziel-DB muss leer sein (nur lesend geprueft, bevor irgendetwas angehalten oder veraendert wird).
    const startedDb = !db.running;
    if (startedDb) await ctx.docker.start(db.id);
    try {
      await assertTargetEmpty(ctx, db.id, target);
    } catch (e) {
      // Zurueck in den vorherigen Zustand: nur stoppen, was der Agent selbst gestartet hat.
      if (startedDb) await ctx.docker.stop(db.id).catch(() => undefined);
      throw e;
    }

    // Ab hier wird das Ziel veraendert: App-Container des Ziel-Stacks anhalten (nicht die Datenbank).
    const project = await ctx.docker.listProject(target.composeProject);
    for (const c of project) {
      if (c.project !== target.composeProject || c.id === db.id || !c.running) continue;
      await ctx.docker.stop(c.id);
      stopped.push(c);
    }
    // --single-transaction: bei einem Fehler bleibt der alte Datenstand unveraendert.
    const restore = ctx.docker.exec(
      db.id,
      ['pg_restore', '--clean', '--if-exists', '--no-owner', '--single-transaction', '-U', target.dbUser, '-d', target.dbName],
      { stdin: plainDump, signal: ctx.signal },
    );
    restore.stdout.resume();
    await expectExit(ctx, restore, 'pg_restore');

    for (const c of stopped) await ctx.docker.start(c.id);
    started = true;

    if (upFile && target.uploadsService && target.uploadsPath) {
      const up = await ctx.docker.findContainer(target.composeProject, target.uploadsService);
      if (!up || up.project !== target.composeProject) throw new Error('Container fuer die Uploads im Ziel-Stack nicht gefunden');
      const plainUp = await decryptStream(ageIdentity, createReadStream(upFile));
      const tar = ctx.docker.exec(up.id, ['tar', 'xzf', '-', '-C', target.uploadsPath], { stdin: plainUp, signal: ctx.signal });
      tar.stdout.resume();
      await expectExit(ctx, tar, 'tar (Uploads)');
    }
    return { objectKey, ...(note ? { note } : {}) };
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
