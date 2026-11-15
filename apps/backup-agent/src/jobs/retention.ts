import { isProtectedKey, setBase } from '../keys.js';
import type { JobContext } from './context.js';

/**
 * Raeumt alte Sicherungssaetze unter `relPrefix` auf (instances/<sub>/ oder control/).
 * Laeuft nur nach einem gelungenen Lauf, loescht nie invoices/* und behaelt
 * immer den neuesten Satz.
 */
export async function pruneOldBackups(ctx: JobContext, relPrefix: string): Promise<number> {
  if (isProtectedKey(ctx.keyPrefix + relPrefix)) return 0;
  const cutoff = ctx.now().getTime() - ctx.target.retentionDays * 86_400_000;
  const objects = await ctx.storage.list(ctx.keyPrefix + relPrefix);
  const sets = new Map<string, string[]>();
  for (const o of objects) {
    if (isProtectedKey(o.key)) continue;
    const base = setBase(o.key);
    if (base === o.key) continue; // gehoert nicht zu unseren Saetzen
    sets.set(base, [...(sets.get(base) ?? []), o.key]);
  }
  const bases = [...sets.keys()].sort();
  const newest = bases[bases.length - 1];
  let removed = 0;
  for (const base of bases) {
    if (base === newest) continue;
    const m = /(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(base);
    if (!m) continue;
    const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
    if (t >= cutoff) continue;
    for (const key of sets.get(base)!) {
      await ctx.storage.delete(key);
      removed++;
    }
  }
  return removed;
}
