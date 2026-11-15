import type { ConsentStatus } from '.prisma/control-client';

/**
 * ===========================================================================
 * [K4] EINE SPERRE DARF NUR STÄRKER WERDEN, NIE SCHWÄCHER
 * ===========================================================================
 *
 * Die Sperrroute aus [W4] schrieb den mitgegebenen Zustand bedingungslos. Damit
 * liess sich eine bestehende Sperre ABSCHWÄCHEN — und das ist kein
 * Schönheitsfehler, sondern der Weg zurück in genau den Vorgang, den die
 * Sperre verhindern soll. Gemessen:
 *
 * ```
 * 2. sperre spam_gemeldet  200 -> spam_gemeldet
 * 3. Formular              200 -> spam_gemeldet   (richtig: keine Mail)
 * 4. sperre abgemeldet     200 -> abgemeldet      <-- Abschwächung
 * 5. Formular              200 -> unbestaetigt    <-- wieder anschreibbar
 * Mailpit: 2 Bestätigungsmails, die zweite NACH der Spam-Meldung
 * ```
 *
 * Eine Spam-Meldung kommt über den Feedback-Loop des Postfachanbieters. Eine
 * erneute Double-Opt-in-Mail an genau diese Adresse ist der Vorgang, der die
 * nächste Beschwerde und die Blocklistung der Domäne auslöst — und die hängt
 * an derselben Reputation wie die Rechnungsmails.
 *
 * WARUM DER FEHLER DURCHKAM, obwohl der Quelltext dreimal das Gegenteil
 * versprach: Der Test, der ihn absichern sollte, prüfte die ROUTENLISTE auf
 * Namen wie „entsperren". Er konnte gar nicht sehen, dass die Sperrroute selbst
 * abschwächt — und gab deshalb falsche Sicherheit. Der Ersatz prüft die
 * ÜBERGANGSMATRIX: jeden Ausgangszustand gegen jeden Sperrgrund.
 *
 * DIE RANGORDNUNG:
 *
 *   0  unbestaetigt, bestaetigt  — keine Sperre
 *   1  abgemeldet                — Widerspruch der Person; sie kann
 *                                  zurückkommen, indem sie sich neu einträgt
 *   2  hart_abgewiesen           — die Adresse nimmt nichts an; die Rückkehr
 *                                  ist möglich, weil der Double-Opt-in selbst
 *                                  beweist, dass sie wieder lebt
 *   3  spam_gemeldet             — Beschwerde. Endgültig, ohne Weg zurück
 *
 * Geschrieben wird nur bei ECHT HÖHEREM Rang. Gleicher Rang heisst: es ändert
 * sich nichts — auch das ist kein Fehler, sondern der Normalfall bei einer
 * zweiten Meldung derselben Art.
 */
export const BLOCK_RANK: Record<ConsentStatus, number> = {
  unconfirmed: 0,
  confirmed: 0,
  unsubscribed: 1,
  hard_bounced: 2,
  spam_reported: 3,
};

/**
 * Darf `neu` über `vorhanden` geschrieben werden?
 *
 * `vorhanden === null` heisst: es gibt noch keine Zeile. Dann darf jeder
 * Sperrzustand geschrieben werden — ein Widerspruch von jemandem, der bei uns
 * gar nicht steht, muss trotzdem wirken.
 */
export function mayBlockWrite(
  present: ConsentStatus | null,
  incoming: ConsentStatus,
): boolean {
  if (present === null) return true;
  return BLOCK_RANK[incoming] > BLOCK_RANK[present];
}

/**
 * Der Zustand, der nach einer Sperrmeldung gilt — der stärkere von beiden.
 *
 * Als eigene Funktion, damit der Übergangstest die ganze Matrix gegen genau
 * diese eine Stelle halten kann und nicht gegen eine Nacherzählung davon.
 */
export function strongerState(
  present: ConsentStatus | null,
  incoming: ConsentStatus,
): ConsentStatus {
  return mayBlockWrite(present, incoming) ? incoming : present!;
}
