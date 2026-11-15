/**
 * Verschlüsselung des Postausgangs ist in Produktion nicht abschaltbar.
 *
 * `SMTP_TLS_ERZWINGEN=0` setzt `requireTLS` aus. Über diese Verbindung geht
 * der ACHTSTELLIGE ANMELDECODE — der zweite Faktor — dazu `SMTP_USER` und
 * `SMTP_PASS`. Ohne erzwungenes STARTTLS genügt es, die Fähigkeit aus der
 * EHLO-Antwort zu streichen, und nodemailer verschickt alles im Klartext. Das
 * ist kein Restrisiko, sondern die Aushebelung des Faktors.
 *
 * Deshalb ein STARTABBRUCH und keine Log-Warnung: eine Sicherheitsmaßnahme,
 * die sich per Umgebungsvariable abschalten lässt, wird irgendwann bei einer
 * Fehlersuche abgeschaltet und nie wieder eingeschaltet. Der Unterschied
 * zwischen Warnung und Abbruch ist der zwischen „ist jemandem aufgefallen" und
 * „kann nicht passieren".
 *
 * Die Ausnahme für die Entwicklung bleibt bewusst an `NODE_ENV` hängen und
 * nicht an einer Hostnamen-Heuristik: „localhost ist schon in Ordnung" wäre
 * genau die Bequemlichkeit, die diese Prüfung verhindern soll.
 */
export function checkTlsRequirement(
  nodeEnv: string | undefined,
  tlsEnforce: string | undefined,
): void {
  if (nodeEnv !== 'production') return;
  // Nur der ausdrückliche Wert "0" schaltet ab (siehe MailService); alles
  // andere, auch „nicht gesetzt", bedeutet erzwungen.
  if ((tlsEnforce ?? '1') !== '0') return;

  throw new Error(
    'SMTP_TLS_ERZWINGEN=0 ist bei NODE_ENV=production nicht zulässig. ' +
      'Über den Postausgang geht der achtstellige Anmeldecode — der zweite ' +
      'Faktor — zusammen mit SMTP_USER und SMTP_PASS. Ohne erzwungenes ' +
      'STARTTLS können beide im Klartext übertragen werden, es genügt ein ' +
      'Postausgang, der STARTTLS nicht anbietet. Entweder SMTP_TLS_ERZWINGEN ' +
      'entfernen (Vorgabe: erzwungen) oder einen Postausgang einsetzen, der ' +
      'Verschlüsselung beherrscht. Die Abschaltung ist ausschließlich für die ' +
      'lokale Entwicklung gegen Mailpit gedacht, das kein STARTTLS spricht.',
  );
}
