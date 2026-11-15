/**
 * Maskiert eine E-Mail-Adresse für die Anzeige.
 *
 * Die ersten zwei Zeichen des lokalen Teils bleiben stehen, dahinter drei
 * Sternchen, die Domain bleibt vollständig lesbar: `ad***@example.com`.
 * Bei nur einem Zeichen vor dem `@` bleibt dieses eine sichtbar (`a***@…`).
 *
 * Reine Anzeigefunktion, keine Sicherheitsgrenze: Wer die Seite sieht, ist
 * entweder angemeldet oder hat sein Passwort gerade bewiesen. Die Maskierung
 * schützt nur gegen Mitlesende über die Schulter.
 */
export function maskEmail(address: string): string {
  const separator = address.lastIndexOf('@');
  // Ohne erkennbaren lokalen Teil gibt es nichts zu maskieren — dann lieber
  // unverändert anzeigen als eine sinnlose Sternchenkette.
  if (separator < 1) return address;
  // Höchstens bis zum `@`: bei einem einzigen Zeichen davor darf der Trenner
  // nicht als „sichtbares Zeichen" durchgehen.
  const visible = address.slice(0, Math.min(2, separator));
  return `${visible}***${address.slice(separator)}`;
}
