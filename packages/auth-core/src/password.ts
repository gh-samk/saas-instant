import { randomBytes } from 'crypto';
import * as argon2 from 'argon2';

/**
 * Parameter für alle Passwort- und Code-Hashes: argon2id mit den Standardwerten
 * der `argon2`-Bibliothek. Sie stehen an EINER Stelle, damit Verwaltung und
 * Portal-Anmeldedienst nie auseinanderlaufen. Der Hash enthält seine Parameter
 * selbst — ältere Hashes bleiben prüfbar, wenn die Werte hier einmal steigen.
 */
export const ARGON2_OPTIONS = { type: argon2.argon2id } as const;

/** Hasht ein Passwort (oder einen Code) mit argon2id. */
export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
}

/**
 * Prüft ein Passwort gegen einen Hash. Wirft bei einem beschädigten Hash —
 * der Aufrufer entscheidet, ob das ein stilles „falsch" ist oder einen
 * eigenen Audit-Grund bekommt.
 */
export function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain);
}

/** Wie `verifyPassword`, aber ein beschädigter Hash zählt als „falsch". */
export async function verifyPasswordOrFalse(
  hash: string,
  plain: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/**
 * Wird beim ersten Bedarf einmal erzeugt und dann wiederverwendet: gegen diesen
 * Hash wird verifiziert, wenn die Kennung unbekannt ist. Ohne das kehrt die
 * Anmeldung bei unbekannter Kennung sofort zurück, während sie bei bekannter
 * Kennung ~100 ms für argon2 braucht — dieser Unterschied ist über das Netz
 * messbar und verrät, welche Konten existieren.
 */
let dummyHash: Promise<string> | null = null;

function getDummyHash(): Promise<string> {
  if (!dummyHash) {
    // Inhalt egal, nur die Rechenzeit zählt. Zufällig, damit er nie zufällig
    // zu einer echten Eingabe passt.
    dummyHash = hashPassword(randomBytes(32).toString('hex'));
  }
  return dummyHash;
}

/**
 * Verifiziert gegen einen Wegwerf-Hash und verwirft das Ergebnis. Für den
 * Zweig „Kennung unbekannt / kein Passwort": derselbe Rechenaufwand wie bei
 * einem echten Konto. Der Aufruf MUSS bleiben, auch wenn sein Ergebnis
 * verworfen wird.
 */
export async function verifyAgainstDummy(plain: string): Promise<void> {
  await argon2.verify(await getDummyHash(), plain).catch(() => false);
}

/**
 * Verbrennt so viel Rechenzeit wie das Hashen eines Codes. Das Ergebnis wird
 * verworfen — es geht allein um die Dauer.
 */
export async function burnHashTime(): Promise<void> {
  await hashPassword(randomBytes(16).toString('hex'));
}
