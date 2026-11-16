import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';

/**
 * Einmal-Token: 32 Zufallsbytes, URL-sicher.
 *
 * `base64url` und nicht `base64`: Der Token steht in einer Adresse, und `+`
 * und `/` würden dort prozentkodiert — womit der kopierte Link ein anderer
 * wäre als der ausgestellte. Der Klartext wird nie gespeichert, nur sein Hash
 * (`hashToken`). Kein Salz und kein langsames Verfahren, mit Absicht: bei 256
 * Bit Zufall gibt es nichts zu erraten.
 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 als Hex — so steht ein Token in der Datenbank. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** CSRF-Token für das Double-Submit-Verfahren: 24 Zufallsbytes als Hex. */
export function generateCsrfToken(): string {
  return randomBytes(24).toString('hex');
}

/**
 * Vergleicht zwei Zeichenketten zeitkonstant. Unterschiedliche Längen können
 * nicht zeitkonstant verglichen werden — das ist unkritisch, weil die Länge
 * von Token fest ist und kein Geheimnis darstellt.
 */
export function sameConstantTime(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Zahlen-Code der Länge `length`, ziffernweise mit `randomInt` gezogen
 * (NICHT `Math.random`, das vorhersagbar ist): jede Stelle gleichverteilt,
 * führende Nullen kommen selbstverständlich vor.
 */
export function generateNumericCode(length: number): string {
  let code = '';
  for (let place = 0; place < length; place += 1) {
    code += String(randomInt(0, 10));
  }
  return code;
}
