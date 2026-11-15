import { createHash, timingSafeEqual } from 'crypto';

/**
 * Vergleicht den mitgeschickten Schlüssel zeitkonstant mit dem erwarteten.
 *
 * Verglichen werden die SHA-256-SUMMEN, nicht die Zeichenketten selbst. Der
 * Grund ist die Länge: `timingSafeEqual` verlangt gleich lange Puffer, ein
 * vorgeschalteter Längenvergleich verrät also die Länge des Geheimnisses.
 * Über die Summe sind beide Seiten immer 32 Byte lang, und die Laufzeit hängt
 * an nichts, was der Aufrufer beeinflusst.
 *
 * Ein leerer oder fehlender Schlüssel ist immer falsch — und wird trotzdem
 * denselben Weg entlang geprüft.
 */
export function keyMatches(
  included: string | undefined,
  expected: string,
): boolean {
  if (expected === '') return false;
  const a = createHash('sha256').update(included ?? '', 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** Name des Headers, in dem der Schlüssel steht. */
export const KEY_HEADER = 'x-inquiry-key';
