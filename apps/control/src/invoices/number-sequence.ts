import type { Prisma } from '.prisma/control-client';

/**
 * DER LÜCKENLOSE NUMMERNKREIS.
 *
 * Harte Regel R2, wörtlich: „Die fortlaufende Rechnungsnummer wird erst beim
 * Festschreiben vergeben, in derselben Datenbanktransaktion, mit Sperre gegen
 * Nebenläufigkeit. Es darf keine Lücke im Nummernkreis entstehen."
 *
 * ---------------------------------------------------------------------------
 * WARUM KEINE POSTGRES-SEQUENZ
 *
 * Eine Sequenz wäre der naheliegende Weg und ist genau deshalb falsch:
 * `nextval` ist absichtlich transaktionsUNabhängig. Wer eine Nummer zieht und
 * dann zurückrollt — weil die Pflichtangaben unvollständig sind, weil die
 * Verbindung abreißt, weil der Prozess stirbt —, hinterlässt eine LÜCKE. Genau
 * das, was R2 ausschließt. Eine Sequenz erfüllt „keine Doppelnummer", aber
 * nicht „keine Lücke".
 *
 * ---------------------------------------------------------------------------
 * WARUM `pg_advisory_xact_lock` UND `max + 1`
 *
 * Die Beratungssperre gilt für die Dauer der Transaktion und wird beim Commit
 * WIE BEIM ROLLBACK freigegeben. Daraus folgt beides zugleich:
 *
 * - KEINE DOPPELNUMMER: Zwei Festschreibungen desselben Jahres können nicht
 *   gleichzeitig zwischen „höchste Nummer lesen" und „Zeile schreiben" stehen.
 *   Die zweite wartet, bis die erste fertig ist.
 * - KEINE LÜCKE: Die Nummer entsteht aus dem, was TATSÄCHLICH in der Tabelle
 *   steht. Rollt eine Festschreibung zurück, ist ihre Zeile nie entstanden,
 *   und die nächste bekommt dieselbe Nummer. Eine Sequenz könnte das nicht.
 *
 * Voraussetzung ist die Isolationsstufe READ COMMITTED — nur dort sieht die
 * wartende Transaktion nach dem Aufwachen die inzwischen festgeschriebene
 * Zeile. Unter REPEATABLE READ läge ihr Schnappschuss VOR der Sperre, und sie
 * berechnete dieselbe Nummer noch einmal. Das ist der Vorgabewert von
 * PostgreSQL, aber der Aufrufer setzt ihn ausdrücklich (siehe
 * `InvoiceService.festschreiben`), damit die Voraussetzung im Code steht und
 * nicht in einer Serverkonfiguration.
 *
 * DIE SPERRE IST PRO JAHR. Zwei Jahreswechsel-Rechnungen behindern sich nicht,
 * und der Zähler beginnt im neuen Jahr von selbst wieder bei 1 — ohne dass
 * irgendwo etwas zurückgesetzt werden müsste und ohne die alten Nummern zu
 * berühren.
 */

/**
 * Kennung der Beratungssperre für ein Jahr.
 *
 * Der Zahlenraum ist der von `pg_advisory_xact_lock(bigint)` und wird sich mit
 * nichts anderem überschneiden: `public.service.ts` leitet seine Schlüssel
 * aus einem SHA-256 ab und trifft diesen engen Bereich praktisch nie. Der
 * Präfix macht die Absicht trotzdem sichtbar.
 */
export function lockKeyForYear(year: number): bigint {
  if (!Number.isInteger(year) || year < 1970 || year > 9999) {
    throw new TypeError(`Unbrauchbares Rechnungsjahr: ${year}`);
  }
  // 0x524E = "RN" (Rechnungsnummer), dahinter das Jahr.
  return BigInt(0x524e) * 100_000n + BigInt(year);
}

/** Format der Rechnungsnummer: `JJJJ-NNN`, mindestens drei Stellen. */
export function formatNumber(year: number, running: number): string {
  return `${year}-${String(running).padStart(3, '0')}`;
}

/**
 * Zerlegt eine Rechnungsnummer. `null`, wenn sie nicht dem Format entspricht.
 *
 * Ab der tausendsten Rechnung eines Jahres wird die Nummer vierstellig
 * (`2026-1000`). Das ist Absicht: Lieber eine Stelle mehr als ein Überlauf.
 * Deshalb wird auch NUMERISCH verglichen und nicht alphabetisch — `2026-1000`
 * sortiert als Text vor `2026-999`.
 */
export function splitNumber(
  number: string,
): { year: number; running: number } | null {
  const hits = /^(\d{4})-(\d{3,})$/.exec(number);
  if (hits === null) return null;
  return { year: Number(hits[1]), running: Number(hits[2]) };
}

/**
 * Vergibt die nächste Nummer des Jahres — INNERHALB einer laufenden
 * Transaktion.
 *
 * Der Parameter ist ein `TransactionClient` und kein `PrismaService`: Ein
 * Aufruf außerhalb einer Transaktion wäre wirkungslos, weil die Sperre sofort
 * wieder fiele. Der Typ macht diesen Fehler unmöglich, statt ihn zu
 * kommentieren.
 */
export async function assignNextNumber(
  tx: Prisma.TransactionClient,
  year: number,
): Promise<string> {
  // `$executeRaw` und nicht `$queryRaw`: Die Sperrfunktion liefert `void`
  // zurück, und daran scheitert die Ergebnisumwandlung von Prisma
  // (dieselbe Stelle wie in `public.service.ts`).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKeyForYear(year)})`;

  const taken = await tx.invoice.findMany({
    where: { invoiceNumber: { startsWith: `${year}-` } },
    select: { invoiceNumber: true },
  });

  const highest = taken.reduce((largest, row) => {
    const split =
      row.invoiceNumber === null ? null : splitNumber(row.invoiceNumber);
    // Der Jahresvergleich ist nicht überflüssig: `startsWith` träfe auch eine
    // von Hand eingetragene Nummer wie „2026-abc" oder „20261-1".
    if (split === null || split.year !== year) return largest;
    return Math.max(largest, split.running);
  }, 0);

  return formatNumber(year, highest + 1);
}
