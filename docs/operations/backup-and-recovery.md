# Sicherung und Wiederherstellung

Dieses Dokument beschreibt, was gesichert werden muss, wie die Sicherung der
Verwaltung gemeldet wird und wie eine Datenbank von Hand zurückgespielt wird.

**Was saas-instant liefert und was nicht:** Das Repository enthält **kein
Sicherungswerkzeug**. Gesichert wird mit einem Werkzeug, das der Betreiber auf
dem Server einrichtet (Beispiel: `pg_dump`, Verschlüsselung mit `age`, Ablage
per `rclone` in einem S3-Speicher, ausgelöst per Cron). Die Verwaltung bietet nur
den **Meldeweg** dafür (Abschnitt 2) und zeigt Alter und Größe der letzten
Sicherung je Instanz.

## 1. Was gesichert werden muss

| Was | Wo es liegt | Warum |
|---|---|---|
| Datenbank der Verwaltung (`control`) | Volume `control-db-data` im Compose-Stapel der Verwaltung (Dienst `control-db`) | Kunden, Instanzregister, Rechnungen samt ausgegebenem PDF/XML (Spalten `pdfContent`, `xmlContent`), Audit-Log |
| Datenbank je Kundeninstanz | im Compose-Stapel der Instanz | Arbeitsdaten der Kundschaft |
| Hochgeladene Dateien je Kundeninstanz | Volume der Instanz | gehört zum Datenstand der Datenbank |
| `CONTROL_CONFIG_KEY` und `JWT_SECRET` der Verwaltung | `.env` der Installation | siehe unten |

**`CONTROL_CONFIG_KEY` gehört gesondert gesichert**, nicht zusammen mit den
Datenbank-Dumps. Er verschlüsselt ruhende Geheimnisse in der Datenbank
(TOTP-Geheimnisse, Setup- und Kennzahlen-Token der Instanzen). Ohne ihn ist ein
zurückgespielter Dump in diesen Feldern unlesbar, und TOTP müsste neu
eingerichtet werden. Mit Dump und Schlüssel am selben Ort verliert die
Verschlüsselung ihren Sinn.

Rechnungen unterliegen gesetzlichen Aufbewahrungsfristen. Das ausgegebene
Dokument liegt in der Datenbank der Verwaltung und hängt damit an deren
Sicherung, nicht an einem Volume, das ein Ausrollen überschreiben kann. Welche
Frist gilt, klärt der Betreiber mit seiner Steuerberatung.

### Anforderungen an das Sicherungswerkzeug

| Punkt | Empfehlung | Begründung |
|---|---|---|
| Häufigkeit | mindestens täglich, besser zweimal täglich | Höchstens so viel Arbeit geht im Ernstfall verloren. |
| Ziel | **externer Speicher**, nicht derselbe Server | Eine Sicherung auf derselben Maschine überlebt genau die Störungen nicht, für die es sie gibt. |
| Verschlüsselung | asymmetrisch (z. B. `age`), **nur der öffentliche Schlüssel liegt auf dem Server** | Wer den Server übernimmt, kann sichern, aber nichts zurücklesen. Der private Schlüssel liegt ausschließlich beim Betreiber, im Passwortmanager. |
| Aufbewahrung | mehrere Wochen, aufgeräumt wird je Instanz **nur nach einem gelungenen Lauf** | Eine wochenlange Störung räumt sonst die letzten guten Stände weg. |
| Zugangsdaten zum Speicher | **auf dem Host**, nicht in Kundencontainern und nicht in der Verwaltung | Eine kompromittierte Instanz käme sonst an die Sicherungen aller anderen. |
| Dateien | `pg_dump -Fc` je Datenbank plus Archiv der Uploads | Das Custom-Format erlaubt `pg_restore --list` zur Prüfung. |

Nicht gesichert werden muss eine Demo-Instanz, die sich selbst zurücksetzt.

## 2. Meldung an die Verwaltung

Die Verwaltung hat **keinen Zugang** zum Sicherungsspeicher und soll auch keinen
bekommen: Eine kompromittierte Verwaltung käme sonst an die Daten aller Kunden.
Stattdessen meldet das Sicherungswerkzeug nach **jedem gelungenen Lauf** je
Instanz eine Zeile:

```bash
curl -sS -X POST "https://<verwaltung>/api/backups" \
  -H "content-type: application/json" \
  -H "x-backup-key: $CONTROL_BACKUP_KEY" \
  -d "{\"subdomain\":\"$SLUG\",\"date\":\"$(date +%F)\",\"sizeBytes\":$BYTES}"
```

Den Schlüssel nicht in der Befehlszeile übergeben (sichtbar in der Prozessliste),
sondern aus einer Datei mit Rechten 600 in den Kopf der Anfrage legen, etwa mit
`curl -H @datei`.

| Feld | Bedeutung |
|---|---|
| `subdomain` | Subdomain der Instanz im Register |
| `date` | Tag der Sicherung (`YYYY-MM-DD`), nicht in der Zukunft |
| `sizeBytes` | Größe in Byte, ganze Zahl |

Verhalten des Endpunkts:

- `CONTROL_BACKUP_KEY` (mindestens 32 Zeichen) muss in der Umgebung der Verwaltung
  gesetzt sein, etwa mit `openssl rand -hex 32`. Ohne ihn **existiert die Route
  nicht** (404). Dann bleibt die Anzeige leer, und jede Instanz erscheint als
  „Sicherung überfällig“. Das ist Absicht: Ein leeres Feld, das nichts sagt, wäre
  schlimmer als ein Fehlalarm.
- Falscher oder fehlender Schlüssel: `401`. Der Vergleich läuft in konstanter Zeit.
- Ein Datum in der Zukunft wird mit `400` abgewiesen. Eine einzige Meldung mit
  falsch gestellter Uhr würde die Überfälligkeits-Aufgabe sonst dauerhaft
  abschalten, und für Sicherungsmeldungen gibt es bewusst keinen Löschpfad. Ein
  Tag Toleranz für Zeitzonen ist eingebaut.
- Jede formal gültige Meldung bekommt `200`, **auch mit unbekannter Subdomain**.
  Der Endpunkt darf mit dem Schlüssel keine Kundenliste verraten. Ein Tippfehler
  im Skript fällt deshalb nicht an der Antwort auf, sondern im Log der Verwaltung
  („Sicherungsmeldung für eine unbekannte Subdomain verworfen“) und später an der
  Aufgabe „Sicherung überfällig“.
- Zwei Meldungen am selben Tag berichtigen dieselbe Zeile (eine Zeile je Instanz
  und Tag).
- Der Meldeweg ist auf 60 Anfragen je Minute begrenzt.

**Warum Meldung statt Abfrage:** Das Ausbleiben der Meldung ist das Signal. Es
gibt bewusst kein Feld „fehlgeschlagen“, denn Sicherungen scheitern in der Praxis
nicht mit einer Fehlermeldung, sondern mit wochenlanger Stille. Die Verwaltung
erzeugt für eine **laufende** Instanz die Aufgabe „Sicherung überfällig“, sobald
zwei Tage ohne Meldung vergangen sind.

Die Datenbank der Verwaltung selbst ist keine Instanz und wird nicht gemeldet.
Ihre Sicherung gehört deshalb in eine eigene Überwachung des Betreibers (zum
Beispiel eine Benachrichtigung des Sicherungswerkzeugs bei Fehlschlag).

## 3. Warum es keinen Wiederherstellungsknopf gibt

Die Verwaltung spielt nie etwas zurück. Das ist Regel R1 (siehe
[security-model.md](security-model.md)): Auf Kundeninstanzen gibt es genau zwei
Schreibvorgänge, anlegen und stoppen, jeweils nach ausdrücklicher Bestätigung.
Eine Wiederherstellung überschreibt einen laufenden Datenbestand. Als Knopf in
einer Liste genügte ein Fehlgriff, um die Arbeit einer Organisation durch einen
Stand von vor Stunden zu ersetzen, ohne dass es jemand sofort merkt. Der Vorgang
gehört an eine Stelle, an der man ihn nicht versehentlich auslöst: auf den Server,
von Hand.

| Die Verwaltung … | |
|---|---|
| zeigt Tag und Größe der letzten Sicherung je Instanz | ja |
| meldet eine ausbleibende Sicherung als Aufgabe | ja |
| stoppt eine Instanz beim Archivieren, nach Bestätigung | ja |
| nennt beim Archivieren den Stand der letzten Sicherung im Verlauf | ja |
| löst selbst eine Sicherung aus | nein |
| löscht ein Deployment oder eine Datenbank | nein, an keiner Stelle |
| spielt eine Sicherung zurück | nein |
| hat SQL-Zugang zu Kundendatenbanken | nein |

Die Zeilen mit „nein“ sind als **Abwesenheit** geprüft: Tests durchsuchen den
Quellbaum nach HTTP-DELETE, nach Aufrufen mit löschendem Namen und nach
Löschaufrufen gegen die Nachweis-Modelle.

**Beim Archivieren zieht die Verwaltung keine Sicherung.** Sie stoppt die Instanz
und schreibt in den Verlauf, wie es um die letzte Sicherung steht. Ist sie zu alt
oder fehlt sie, steht dort ein Warnhinweis. Vor dem Archivieren deshalb einmal
das Sicherungswerkzeug von Hand laufen lassen und prüfen, dass im Verlauf
hinterher „Letzte Sicherung: heute“ steht.

## 4. Der Weg zurück: eine Kundeninstanz

**Vorher lesen:** Die Wiederherstellung überschreibt den laufenden Bestand der
Instanz. Alles seit dem Zeitpunkt der Sicherung ist danach weg. Vorher mit der
Organisation sprechen.

Platzhalter: `<db-container>` (Datenbank-Container der Instanz), `<db-user>` und
`<db-name>` (laut Compose-Datei der Instanz), `<api-container>` (App-Container).

1. **Stand bestimmen.** In der Verwaltung an der Organisation unter „Instanz“ die
   letzte Sicherung ablesen, ältere Stände liegen im Sicherungsspeicher. Notiere
   Subdomain, Datum der Sicherung und Anlass.
2. **Nur die App stoppen, nicht den ganzen Stapel.** Ein Stopp über Coolify hielte
   auch die Datenbank an, die Schritt 5 braucht.
   ```bash
   docker stop <api-container>
   docker exec <db-container> psql -U <db-user> -d postgres -Atc \
     "select count(*) from pg_stat_activity where datname = '<db-name>'"   # muss 0 sein
   ```
   Eine laufende App schreibt sonst während des Zurückspielens weiter. Das
   Ergebnis wäre ein Mischstand, den niemand mehr auseinandersortiert.
3. **Aktuellen Stand sichern, bevor er überschrieben wird.** Von Hand, nicht mit
   dem Sicherungswerkzeug, denn das findet Instanzen oft nur über laufende
   Container. Den Dump verschlüsseln und in den externen Speicher legen, erst
   danach weitermachen. Auch ein kaputter Stand ist die einzige Kopie dessen, was
   seit der letzten Sicherung passiert ist.
4. **Sicherung holen und entschlüsseln, auf dem Rechner des Betreibers.** Dort
   liegt der private Schlüssel, nicht auf dem Server. Danach das Archiv prüfen
   (`pg_restore --list <datei>` zeigt das Inhaltsverzeichnis und ändert nichts)
   und auf den Server kopieren.
5. **In eine Nebendatenbank einspielen und dort nachsehen.**
   ```bash
   docker exec <db-container> psql -U <db-user> -d postgres \
     -c 'CREATE DATABASE restore_check;'
   docker exec -i <db-container> pg_restore -U <db-user> --no-owner \
     --exit-on-error -d restore_check < r.dump
   ```
   Zeilenzahlen wichtiger Tabellen und das jüngste Datum prüfen. Ein Einspielen
   direkt in die Hauptdatenbank ist unumkehrbar, sobald es begonnen hat.
6. **Umschalten.** Stimmt der Stand:
   ```bash
   docker exec <db-container> psql -U <db-user> -d postgres -c \
     'ALTER DATABASE "<db-name>" RENAME TO before_restore;
      ALTER DATABASE restore_check RENAME TO "<db-name>";'
   ```
   `before_restore` bleibt stehen. Sie wird erst gelöscht, wenn die Instanz
   mindestens eine Woche unauffällig läuft, und dann von Hand.
7. **App starten und prüfen.** `docker start <api-container>`. Ein neues Ausrollen
   ist nicht nötig. Beim Start läuft `prisma migrate deploy`, fehlende
   Migrationen einer älteren Sicherung laufen automatisch nach (Normalfall, kein
   Fehler). Danach den Health-Endpunkt der Instanz aufrufen.
8. **Nachweis schreiben.** In der Verwaltung eine Notiz an der Organisation:
   Anlass, Datum der zurückgespielten Sicherung, was zwischen Sicherung und
   Störung verloren ist.

## 5. Der Weg zurück: die Verwaltung selbst

Die Verwaltung hat genau eine Datenbank (`control`, Dienst `control-db`). Die
Schritte entsprechen Abschnitt 4 mit `docker compose` und den Namen aus
`docker-compose.yml`:

1. `docker compose stop control-api control-web`, die Datenbank läuft weiter.
2. Aktuellen Stand sichern, Sicherung holen, entschlüsseln, in eine Nebendatenbank
   einspielen und prüfen (Benutzername und Datenbank heißen `control`).
3. Umbenennen wie in Schritt 6.
4. **Denselben `CONTROL_CONFIG_KEY` wie beim Erzeugen der Sicherung verwenden.**
   Ein anderer Schlüssel macht verschlüsselte Felder unlesbar.
5. `docker compose start control-api control-web`, die Migrationen laufen beim
   Start.

Da jede Verwaltung ihre eigene Datenbank hat, betrifft die Wiederherstellung einer
Verwaltung nie eine andere (Modus `portal`).

## 6. Die Übung, die dieses Dokument nicht ersetzt

**Eine Sicherung, die nie zurückgespielt wurde, ist eine Vermutung.** Vor dem
ersten echten Kunden und danach regelmäßig:

1. Eine aktuelle Sicherung aus dem externen Speicher holen und entschlüsseln.
2. In einen Wegwerf-Postgres (ohne offenen Port) einspielen: `pg_restore
   --exit-on-error` muss ohne Fehler durchlaufen.
3. Zeilenzahlen aller Tabellen mit der laufenden Datenbank vergleichen.
4. Gegenprobe: Mit einem fremden Schlüssel darf sich die Datei nicht öffnen
   lassen, und auf dem Server darf kein privater Schlüssel liegen.
5. Mindestens einmal den ganzen Weg aus Abschnitt 4 an einer Wegwerf-Instanz
   gehen (Stand A sichern, Stand B danach schreiben, zurückspielen, B muss
   verschwunden sein, `before_restore` muss B enthalten) und das Ergebnis im
   eigenen Betriebsjournal festhalten. Abweichungen von dieser Anleitung gehören
   hierher.
