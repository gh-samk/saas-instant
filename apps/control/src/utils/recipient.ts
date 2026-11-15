import type { Company } from '../lib/api';

/**
 * Wie die Empfängerangaben einer Rechnung AUSSEHEN WERDEN.
 *
 * Nur eine VORSCHAU. Der verbindliche Schnappschuss entsteht erst beim
 * Festschreiben im Backend (`rechnung.schnappschuss.ts`), und danach ändert er
 * sich nie wieder — auch nicht, wenn die Organisation umzieht. Genau deshalb
 * gibt es diese Funktion: Vor dem Festschreiben soll sichtbar sein, was gleich
 * hineinkopiert wird, solange sich noch etwas daran ändern lässt.
 *
 * DIE LOGIK IST 1:1 DIE DES BACKENDS, absichtlich doppelt geführt und nicht
 * importiert — ein Import über die App-Grenze zöge Nest-Code in das
 * Browser-Bündel. Weicht sie ab, ist die Vorschau falsch, nicht der Beleg; die
 * begleitenden Tests sind deshalb an denselben Fällen gebaut wie
 * `rechnung.schnappschuss.spec.ts`.
 *
 * DIE RECHNUNGSADRESSE STICHT DIE ANSCHRIFT — aber nur als GANZES. Wer eine
 * abweichende Rechnungsadresse pflegt, will nicht, dass einzelne Felder aus
 * der Hausanschrift dazwischenrutschen; ein halb gefülltes Rechnungsfeld ergäbe
 * sonst eine Anschrift, die es nirgends gibt.
 */
export interface RecipientPreview {
  name: string;
  /** Mehrzeilig, wie sie im Anschriftenfeld steht. */
  address: string;
  email: string | null;
}

function row(...parts: (string | null | undefined)[]): string {
  return parts
    .map((part) => part?.trim() ?? '')
    .filter((part) => part !== '')
    .join(' ');
}

export function recipientPreview(o: Company): RecipientPreview {
  const ownBillingAddress =
    (o.billingStreet ?? '').trim() !== '' ||
    (o.billingPostalCode ?? '').trim() !== '' ||
    (o.billingCity ?? '').trim() !== '';

  const parts = ownBillingAddress
    ? {
        street: row(o.billingStreet, o.billingHouseNumber),
        postalCodeCity: row(o.billingPostalCode, o.billingCity),
        country: o.billingCountry,
      }
    : {
        street: row(o.street, o.houseNumber),
        postalCodeCity: row(o.postalCode, o.city),
        country: o.country,
      };

  return {
    name:
      (o.billingName ?? '').trim() !== ''
        ? (o.billingName as string).trim()
        : o.name.trim(),
    address: [parts.street, parts.postalCodeCity, parts.country?.trim() ?? '']
      .filter((part) => part !== '')
      .join('\n'),
    email:
      o.billingEmail?.trim() || o.contactEmail?.trim() || null,
  };
}
