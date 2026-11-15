import type { PrismaService } from '../prisma/prisma.service';
import { PreviewMissingError } from './instance.errors';

/**
 * VERBRAUCHT DIE PFLICHT-VORSCHAU — GENAU EINMAL.
 *
 * Eigene Datei, damit sich der Vorgang isoliert prüfen lässt
 * (`instance-preview.integration.spec.ts`): Er ist die einzige Stelle, an der
 * das Anlegen ein echtes Rennen hat, das NICHT schon von einem
 * Datenbankschlüssel abgefangen wird.
 *
 * `updateMany` mit `usedAt: null` IN DER BEDINGUNG ist das Ganze: Die
 * Datenbank entscheidet, wer gewinnt. Zwei gleichzeitige Aufrufe bekommen
 * genau einmal `count === 1`.
 *
 * DIE KAPUTTE FASSUNG WÄRE `findFirst` GEFOLGT VON `update`: Beide Aufrufe
 * fänden dieselbe unverbrauchte Zeile, beide schrieben sie um, beide gingen
 * durch. Genau dieser Unterschied ist geprüft — dieselbe Lehre wie beim
 * Statuswechsel in Etappe 2 und beim Sperrzähler in Etappe 1 ([K1]).
 */
export async function consumePreview(
  prisma: PrismaService,
  companyId: string,
  subdomain: string,
): Promise<string> {
  const candidate = await prisma.instancePreview.findFirst({
    where: {
      companyId,
      subdomain,
      usedAt: null,
      validUntil: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (candidate === null) throw new PreviewMissingError();

  const result = await prisma.instancePreview.updateMany({
    where: { id: candidate.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (result.count !== 1) throw new PreviewMissingError();
  return candidate.id;
}
