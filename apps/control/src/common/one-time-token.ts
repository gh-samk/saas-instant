import { createHash, randomBytes } from 'crypto';

/**
 * ===========================================================================
 * EINMAL-TOKEN — erzeugen und hashen, an EINER Stelle
 * ===========================================================================
 *
 * Zwei Wege im Projekt geben einen Link heraus, der genau einmal gilt: der
 * Notfall- und Einladungslink für Konten (`auth/notfall.service.ts`) und seit
 * [A.35] der Zugang zum Aufnahmeformular (`aufnahme/`). Beide brauchen
 * dieselben zwei Handgriffe, und beide brauchen sie RICHTIG.
 *
 * WAS GETEILT WIRD, IST DIE MECHANIK — nicht die Entscheidung. Wie lange ein
 * Token gilt, woran er hängt, wann er verfällt und was beim Einlösen
 * geschieht, bleibt Sache des jeweiligen Dienstes. Geteilt sind nur die zwei
 * Zeilen, bei denen ein Fehler nicht auffällt: zu wenig Zufall, oder ein
 * Klartext-Token in der Datenbank.
 *
 * DER KLARTEXT WIRD NIE GESPEICHERT. Er verlässt den Prozess genau einmal —
 * beim Erzeugen, auf dem Weg in die Mail oder in die Zwischenablage. Wer die
 * Datenbank liest, findet nur den Hash und kann daraus keinen gültigen Link
 * bauen. Das ist der Unterschied zum Einwilligungs-Token, der bewusst im
 * Klartext steht: Der schaltet eine Einwilligung frei, dieser einen Zugang.
 *
 * KEIN SALZ UND KEIN LANGSAMES VERFAHREN, und das ist Absicht. Beides
 * schützt gegen das Erraten schwacher Geheimnisse — ein Passwort. Hier sind
 * es 256 Bit aus `randomBytes`; es gibt nichts zu erraten, und ein
 * Wörterbuchangriff hat kein Wörterbuch. Ein langsamer Hash machte
 * stattdessen jede Prüfung langsam.
 */

/** 32 Zufallsbytes, URL-sicher. */
export function generateToken(): string {
  // `base64url` und nicht `base64`: Der Token steht in einer Adresse, und `+`
  // und `/` würden dort prozentkodiert — womit der kopierte Link ein anderer
  // wäre als der ausgestellte.
  return randomBytes(32).toString('base64url');
}

/** Der Hash, wie er in der Datenbank steht. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
