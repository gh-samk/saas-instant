import { isProtectedKey } from '../keys.js';
import type { JobResult } from '../types.js';
import { parseSubdomain } from '../validate.js';
import type { JobContext } from './context.js';

/**
 * Loescht `instances/<subdomain>/` im Ziel (alle Saetze, auch den neuesten) und
 * meldet `purged`. Einziger Loeschweg ausserhalb der Aufbewahrung; nie unter
 * `invoices/`. Idempotent: ein leeres Praefix ist erledigt und wird erneut gemeldet.
 */
export async function runPurge(ctx: JobContext, subdomain: string): Promise<JobResult> {
  parseSubdomain(subdomain);
  // Das Praefix endet auf `/`: `instances/ab/` trifft nie `instances/abc/`.
  const prefix = `${ctx.keyPrefix}instances/${subdomain}/`;
  if (isProtectedKey(prefix)) throw new Error('Loeschen von Rechnungsarchiven ist nicht erlaubt');
  let removed = 0;
  for (const object of await ctx.storage.list(prefix)) {
    if (!object.key.startsWith(prefix) || isProtectedKey(object.key) || object.key.includes('..')) {
      throw new Error('Unerwarteter Schluessel im Loeschpraefix, Loeschung abgebrochen');
    }
    await ctx.storage.delete(object.key);
    removed++;
  }
  if ((await ctx.storage.list(prefix)).length > 0) throw new Error('Das Praefix ist nach dem Loeschen nicht leer');
  await ctx.control.report({ subdomain, kind: 'purged', date: ctx.now().toISOString().slice(0, 10), sizeBytes: 0 });
  ctx.log.info('Sicherungen einer Instanz geloescht', { subdomain, objekte: removed });
  return { note: `${removed} Objekte geloescht` };
}
