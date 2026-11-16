import type { Prisma } from '.prisma/control-client';

/**
 * ===========================================================================
 * DIE MANDATSREFERENZ — eindeutig, aber nicht lückenlos
 * ===========================================================================
 *
 * Gebaut nach `invoice/nummernkreis.ts`, und der UNTERSCHIED ist wichtiger
 * als die Ähnlichkeit:
 *
 * Bei der Rechnungsnummer ist die LÜCKENLOSIGKEIT gesetzliche Pflicht (R2) —
 * eine fehlende Nummer ist gegenüber dem Finanzamt erklärungsbedürftig.
 * Deshalb steht dort ausführlich, warum eine Postgres-Sequenz nicht taugt.
 *
 * Bei einer Mandatsreferenz verlangt niemand Lückenlosigkeit. Gefordert ist
 * allein EINDEUTIGKEIT je Gläubiger: Zwei Mandate mit derselben Referenz
 * führten zwei Kundinnen unter einem Mandat zusammen, und der Einzug ginge an
 * die falsche Bank.
 *
 * DIE SPERRE WIRD TROTZDEM GENOMMEN. Sie kostet hier nichts — Mandate
 * entstehen selten, und die Transaktion ist kurz. Und sie erspart die
 * Überlegung, ob `max + 1` ohne Sperre unter Nebenläufigkeit sicher wäre
 * (es wäre es nicht). Wer das später vereinfachen möchte, soll diesen Absatz
 * lesen und wissen, was er dabei aufgibt: Lücken sind erlaubt, Doppelungen
 * nicht.
 */

/**
 * Kennung der Beratungssperre für ein Jahr.
 *
 * EIGENER PRÄFIX, damit sie sich nicht mit der des Rechnungskreises
 * überschneidet: Ein Mandat und eine Rechnung desselben Jahres sollen sich
 * nicht gegenseitig aufhalten. `nummernkreis.ts` führt dieselbe Überlegung
 * bereits gegenüber `public.service.ts`.
 */
export function blockKeyForMandateYear(year: number): bigint {
  if (!Number.isInteger(year) || year < 1970 || year > 9999) {
    throw new TypeError(`Unbrauchbares Mandatsjahr: ${year}`);
  }
  // 0x4D52 = "MR" (Mandatsreferenz), dahinter das Jahr.
  // 0x524E = "RN" ist der Rechnungskreis — die beiden Bereiche liegen
  // 0x0DFC * 100_000 auseinander und können sich nicht treffen.
  return BigInt(0x4d52) * 100_000n + BigInt(year);
}

/** Format: `SOZ-JJJJ-NNNN`. Vier Stellen, wie in `docs/operations/billing.md`. */
export function formatMandateReference(
  year: number,
  running: number,
): string {
  return `SOZ-${year}-${String(running).padStart(4, '0')}`;
}

/**
 * Zerlegt eine Mandatsreferenz. `null`, wenn sie nicht dem Format entspricht.
 *
 * Auch fünfstellig, aus demselben Grund wie bei der Rechnungsnummer: lieber
 * eine Stelle mehr als ein Überlauf. Verglichen wird deshalb NUMERISCH —
 * `SOZ-2026-10000` sortiert als Text vor `SOZ-2026-9999`.
 */
export function splitMandateReference(
  reference: string,
): { year: number; running: number } | null {
  const hit = /^SOZ-(\d{4})-(\d{4,})$/.exec(reference);
  if (hit === null) return null;
  return { year: Number(hit[1]), running: Number(hit[2]) };
}

/**
 * Vergibt die nächste Mandatsreferenz — INNERHALB einer laufenden Transaktion.
 *
 * Der Parameter ist ein `TransactionClient` und kein `PrismaService`: Ein
 * Aufruf ausserhalb einer Transaktion wäre wirkungslos, weil die Sperre sofort
 * wieder fiele. Der Typ macht diesen Fehler unmöglich, statt ihn zu
 * kommentieren — dieselbe Bauweise wie beim Rechnungskreis.
 */
export async function assignNextMandateReference(
  tx: Prisma.TransactionClient,
  year: number,
): Promise<string> {
  // `$executeRaw` und nicht `$queryRaw`: Die Sperrfunktion liefert `void`
  // zurück, und daran scheitert die Ergebnisumwandlung von Prisma.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${blockKeyForMandateYear(year)})`;

  // Die Referenz ist verschluesselt: kein `startsWith` in der Datenbank. Die
  // Referenzen werden gelesen (entschluesselt) und hier nach dem Jahr gefiltert;
  // die Sperre oben haelt die Vergabe serialisiert.
  const withReference = await tx.company.findMany({
    where: { sepaMandateReference: { not: null } },
    select: { sepaMandateReference: true },
  });
  const prefix = `SOZ-${year}-`;
  const assigned = withReference.filter((row) =>
    row.sepaMandateReference?.startsWith(prefix),
  );

  const highest = assigned.reduce((largest, row) => {
    const split =
      row.sepaMandateReference === null
        ? null
        : splitMandateReference(row.sepaMandateReference);
    // Der Jahresvergleich ist nicht überflüssig: `startsWith` träfe auch eine
    // von Hand eingetragene Referenz wie „SOZ-2026-abc".
    if (split === null || split.year !== year) return largest;
    return Math.max(largest, split.running);
  }, 0);

  return formatMandateReference(year, highest + 1);
}
