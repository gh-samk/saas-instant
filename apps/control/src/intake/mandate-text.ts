/**
 * ===========================================================================
 * DER WORTLAUT DES SEPA-MANDATS
 * ===========================================================================
 *
 * DER SERVER BAUT IHN SELBST und nimmt ihn NICHT aus dem Formular entgegen.
 * Das ist der Kern: Ein Nachweis, dessen Wortlaut der Absender mitschickt,
 * belegt nur, was der Absender behauptet gelesen zu haben. Er würde seinen
 * eigenen Nachweis diktieren.
 *
 * Gespeichert wird die EINGESETZTE Fassung, nicht die Vorlage — dieselbe
 * Entscheidung wie bei `Einwilligung.formulartextImWortlaut`. Wer die Vorlage
 * später ändert, belegte sonst rückwirkend etwas anderes, als die
 * Kontoinhaberin gelesen hat.
 *
 * Ein Test hält die ANGEZEIGTE Fassung gegen die GESPEICHERTE: Beide entstehen
 * aus derselben Funktion mit denselben Werten, und genau das muss geprüft
 * sein — sonst läse jemand einen Satz und unterschriebe einen anderen.
 *
 * WAS HIER NICHT PASSIERT: kein SEPA-XML, kein Einzug, kein
 * Zahlungsabgleich. Das Mandat wird ERFASST; den Einzug löst die Betreiberin
 * im Onlinebanking aus (`docs/operations/billing.md`).
 */

export interface MandateDetails {
  creditor: string;
  creditorId: string;
  /**
   * `null` auf der ANZEIGE vor dem Absenden: Die Referenz wird erst in der
   * Schreibtransaktion vergeben. Sie vorher zu erfinden hiesse, eine Nummer
   * zu zeigen, die eine andere sein kann — oder den Nummernkreis zu
   * verbrauchen, bevor jemand zugestimmt hat. Im gespeicherten Nachweis ist
   * sie IMMER gesetzt.
   */
  mandateReference: string | null;
  accountHolder: string;
  company: string;
}

/**
 * Der Satz, der neben dem Häkchen steht — und derselbe, der als Nachweis
 * gespeichert wird.
 *
 * Er nennt alles, was ein Mandat nennen muss: wen es ermächtigt, wofür, unter
 * welcher Referenz, und dass es widerrufbar ist. Die Achtwochenfrist steht
 * ausdrücklich darin; sie ist ein Recht der Kontoinhaberin, und ein Mandat,
 * das sie verschweigt, ist ein schlechteres Mandat.
 */
export function mandateText(details: MandateDetails): string {
  return [
    `Ich ermächtige ${details.creditor}, Zahlungen von meinem Konto mittels `,
    'Lastschrift einzuziehen. Zugleich weise ich mein Kreditinstitut an, die ',
    `von ${details.creditor} auf mein Konto gezogenen Lastschriften `,
    'einzulösen.',
    '\n\n',
    `Gläubiger-Identifikationsnummer: ${details.creditorId}\n`,
    details.mandateReference === null
      ? 'Mandatsreferenz: wird beim Absenden vergeben und euch mitgeteilt\n'
      : `Mandatsreferenz: ${details.mandateReference}\n`,
    `Kontoinhaberin: ${details.accountHolder}\n`,
    `Für: ${details.company}`,
    '\n\n',
    'Hinweis: Ich kann innerhalb von acht Wochen, beginnend mit dem ',
    'Belastungsdatum, die Erstattung des belasteten Betrages verlangen. Es ',
    'gelten dabei die mit meinem Kreditinstitut vereinbarten Bedingungen. ',
    'Dieses Mandat kann ich jederzeit widerrufen.',
  ].join('');
}
