import { createHash } from 'node:crypto';
import { splitNumber } from './number-sequence';

/**
 * REINE PRUEFLOGIK DES INTEGRITAETSLAUFS (GoBD).
 *
 * Nichts hier liest die Datenbank. Die Funktionen bekommen Bytes und gespeicherte
 * Pruefsummen bzw. Rechnungsnummern und sagen, ob beides zusammenpasst. So sind
 * sie ohne Datenbank testbar, und der Dienst (`integrity.service.ts`) und die
 * Aufgabenquelle (`document-tampered.source.ts`) benutzen dieselbe Bedeutung der
 * Ergebniswerte.
 *
 * Das Ergebnis wird NIE in Invoice-Spalten gespeichert: Die Datenbank-Trigger
 * lassen an einer festgeschriebenen Rechnung nur Status-, Zahlungs- und
 * Uebertragungsfelder zu. Eine Abweichung steht im Audit-Log
 * (`invoice.integrity_failed`) und wird als Aufgabe live berechnet.
 */

export type DocumentFormatKey = 'pdf' | 'xml' | 'xrechnung';

/** Die drei Dokumentspalten und ihre Hash-Spalten. */
export const DOCUMENT_COLUMNS: readonly {
  format: DocumentFormatKey;
  content: 'pdfContent' | 'xmlContent' | 'xrechnungContent';
  hash: 'pdfSha256' | 'xmlSha256' | 'xrechnungSha256';
}[] = [
  { format: 'pdf', content: 'pdfContent', hash: 'pdfSha256' },
  { format: 'xml', content: 'xmlContent', hash: 'xmlSha256' },
  { format: 'xrechnung', content: 'xrechnungContent', hash: 'xrechnungSha256' },
];

/**
 * Ergebnis der Pruefung EINES Dokuments.
 *
 * - `ok`: Bytes und gespeicherte Pruefsumme passen zusammen.
 * - `absent`: noch nie erzeugt (weder Bytes noch Pruefsumme). KEIN Befund — ein
 *   Dokument entsteht erst beim ersten Abruf.
 * - `mismatch`: Bytes ergeben eine andere Pruefsumme (veraendert).
 * - `missing_content`: Pruefsumme steht da, die Bytes fehlen (entfernt).
 * - `missing_hash`: Bytes liegen vor, aber keine Pruefsumme (nicht pruefbar).
 */
export type DocumentStatus =
  | 'ok'
  | 'absent'
  | 'mismatch'
  | 'missing_content'
  | 'missing_hash';

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface DocumentCheck {
  status: DocumentStatus;
  expected: string | null;
  actual: string | null;
}

/** Vergleicht die Bytes eines Dokuments mit der gespeicherten Pruefsumme. */
export function checkDocument(
  content: Uint8Array | null,
  storedHash: string | null,
): DocumentCheck {
  if (content === null) {
    return storedHash === null
      ? { status: 'absent', expected: null, actual: null }
      : { status: 'missing_content', expected: storedHash, actual: null };
  }
  const actual = sha256Hex(content);
  if (storedHash === null) {
    return { status: 'missing_hash', expected: null, actual };
  }
  return {
    status: actual === storedHash.toLowerCase() ? 'ok' : 'mismatch',
    expected: storedHash,
    actual,
  };
}

/** Ein Befund ist alles ausser `ok` und `absent`. */
export function isFailure(status: DocumentStatus): boolean {
  return status !== 'ok' && status !== 'absent';
}

export interface NumberGap {
  year: number;
  /** Fehlende laufende Nummern, aufsteigend (hoechstens `maxListed`). */
  missing: number[];
  /** Wie viele insgesamt fehlen. */
  missingTotal: number;
  /** Hoechste vergebene laufende Nummer des Jahres. */
  highest: number;
}

export interface NumberCheckResult {
  gaps: NumberGap[];
  /** Nummern, die nicht dem Format `JJJJ-NNN` entsprechen. */
  unparseable: string[];
  /** Doppelte Nummern (kann die Unique-Constraint verhindern; Pruefung bleibt). */
  duplicates: string[];
}

/**
 * Luecken im Nummernkreis, je Jahr.
 *
 * Erwartet: Je Jahr sind die laufenden Nummern 1..max vollstaendig vergeben
 * (der Kreis ist luckenlos, R2). `onlyYear` beschraenkt die Pruefung auf ein
 * Jahr; die uebrigen Nummern werden dann ignoriert.
 */
export function findNumberGaps(
  numbers: readonly string[],
  options: { onlyYear?: number; maxListed?: number } = {},
): NumberCheckResult {
  const maxListed = options.maxListed ?? 50;
  const byYear = new Map<number, Set<number>>();
  const unparseable: string[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];

  for (const number of numbers) {
    if (seen.has(number)) {
      duplicates.push(number);
      continue;
    }
    seen.add(number);
    const parts = splitNumber(number);
    if (parts === null) {
      unparseable.push(number);
      continue;
    }
    if (options.onlyYear !== undefined && parts.year !== options.onlyYear) {
      continue;
    }
    const set = byYear.get(parts.year) ?? new Set<number>();
    set.add(parts.running);
    byYear.set(parts.year, set);
  }

  const gaps: NumberGap[] = [];
  for (const year of [...byYear.keys()].sort((a, b) => a - b)) {
    const set = byYear.get(year) as Set<number>;
    const highest = Math.max(...set);
    const missing: number[] = [];
    let missingTotal = 0;
    for (let n = 1; n <= highest; n++) {
      if (!set.has(n)) {
        missingTotal++;
        if (missing.length < maxListed) missing.push(n);
      }
    }
    if (missingTotal > 0) gaps.push({ year, missing, missingTotal, highest });
  }
  return { gaps, unparseable, duplicates };
}

/** Eine Zeile des `checks[]`-Arrays der Antwort. */
export interface IntegrityCheckLine {
  /** Stabiler Name: `pdf_sha256`, `xml_sha256`, `xrechnung_sha256`, `number_sequence`. */
  check: string;
  ok: boolean;
  /** Maschinenlesbarer Zustand (`ok`, `absent`, `mismatch`, ...). */
  status: string;
  /** Nur bei Abweichung: erwartete und tatsaechliche Pruefsumme bzw. fehlende Nummern. */
  detail?: Record<string, unknown>;
}

export interface IntegrityResult {
  invoiceId: string;
  invoiceNumber: string | null;
  /** Entwuerfe haben nichts zu pruefen. */
  finalized: boolean;
  ok: boolean;
  /** UTC, ISO-8601. */
  checkedAt: string;
  checks: IntegrityCheckLine[];
}

/** Baut die Pruefzeile fuer ein Dokument. */
export function documentLine(
  format: DocumentFormatKey,
  result: DocumentCheck,
): IntegrityCheckLine {
  const line: IntegrityCheckLine = {
    check: `${format}_sha256`,
    ok: !isFailure(result.status),
    status: result.status,
  };
  if (isFailure(result.status)) {
    line.detail = { expected: result.expected, actual: result.actual };
  }
  return line;
}
