/**
 * Hebt jede Antwort auf eine feste Mindestdauer an.
 *
 * Zweck ist AK38: Auf einer anonymen Route darf die Antwortzeit nicht
 * verraten, ob es eine Kennung gibt. Das war der Befund [K2] — gemessen wurden
 * 29 ms (unbekannte Kennung), 87 ms (Konto mit E-Mail-Faktor, weil der
 * SMTP-Roundtrip im Antwortpfad hing) und 6,5 ms (Code jünger als 60 Sekunden,
 * weil dieser Zweig vor jeder Rechenarbeit zurückkehrte). Die Verteilungen
 * überlappten nirgends; eine einzige Anfrage trennte die Fälle.
 *
 * Zwei Maßnahmen greifen ineinander, keine genügt allein:
 *
 * 1. Jeder Zweig rechnet GENAU EINEN argon2-Hash — der echte beim Erzeugen
 *    eines Codes, sonst ein Wegwerf-Hash. Das gleicht die teure Arbeit an.
 * 2. Diese Schranke hier deckelt den Rest. Solange die Arbeit unter der
 *    Mindestdauer bleibt, ist die gemessene Zeit für ALLE Zweige dieselbe —
 *    unabhängig davon, wie viele Abfragen ein Zweig gerade gebraucht hat.
 *
 * Ein Nachbrenner fehlt bewusst: eine Obergrenze lässt sich nicht erzwingen,
 * ohne die Antwort abzuschneiden. Deshalb darf im Antwortpfad nichts stehen,
 * dessen Dauer von außen bestimmt wird — der Mailversand gehört dort nicht
 * hin und läuft nebenläufig weiter.
 */
export async function withMinDuration<T>(
  minDurationMs: number,
  work: () => Promise<T>,
  now: () => number = () => Date.now(),
): Promise<T> {
  const start = now();
  try {
    return await work();
  } finally {
    // Auch im Fehlerfall warten: sonst wäre ein früher Wurf wieder ein
    // eigener, schnellerer Zweig.
    const elapsed = now() - start;
    if (elapsed < minDurationMs) {
      await new Promise((done) =>
        setTimeout(done, minDurationMs - elapsed),
      );
    }
  }
}
