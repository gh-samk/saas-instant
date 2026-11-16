# Projektkonventionen

Im Code wird an einigen Stellen auf diese Regeln verwiesen („Regel 1 der Projektkonventionen“).

1. **Fachliche Daten sind Tagesdaten.** Datumsangaben mit fachlicher Bedeutung (Rechnungsdatum, Leistungszeitraum, Fristen, Notizdatum) werden als `YYYY-MM-DD` ohne Uhrzeit gespeichert (`@db.Date`) und übertragen, nie als ISO-Zeitstempel. Zeitpunkte mit Uhrzeit (Anmeldung, Protokoll, Einwilligungsnachweis) sind begründete Ausnahmen und im Schema als solche gekennzeichnet.
2. **Der Server prüft alles.** Prüfungen im Browser (`required`, Formate) sind nur Komfort. Jede Regel gilt zusätzlich serverseitig, auch für direkte Anfragen an die API.
3. **Ein Fehlerformat.** Fachliche Fehler antworten mit passendem HTTP-Status und `{ "error": { "code": "...", "message": "..." } }`. Programmfehler werden als fachliche Fehler mit Code geworfen statt als nackte `Error` und landen so nicht als 500 ohne Code beim Client.
