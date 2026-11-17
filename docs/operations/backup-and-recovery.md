# Sicherung und Wiederherstellung

Dieses Dokument beschreibt, wie Sicherungen entstehen, wo sie liegen, wie man sie
einrichtet und wie man eine Instanz oder die Verwaltung selbst zurückholt.

**Ehrlicher Stand:** Der Backup-Agent ist gegen eine kleine Docker-Compose-Attrappe
(eine Datenbank samt Volume mit Labels, wie Coolify sie vergibt) und gegen
Ersatz-Gegenstellen getestet, **nicht** gegen eine echte Coolify-Installation und
nicht gegen die Produktivumgebung eines Anbieters. Rechnen Sie bei der ersten
echten Inbetriebnahme mit Nacharbeit, und spielen Sie vor dem ersten Kunden einmal
den ganzen Weg an einer Wegwerf-Instanz durch (Abschnitt 9).

## 1. Architektur: warum ein Agent

```
 Betreiber ─► control-web ─► control-api ──HMAC-signiert──► backup-agent ──► Sicherungsziel
                               │  ▲  (Compose-Netz, Port 8787)   │  │         (S3 oder SFTP)
                               │  └── GET  /api/internal/backup-plan
                               │      POST /api/backups  (x-backup-key)
                               ▼                                 ▼
                          control-db                  docker-socket-proxy ─► docker.sock (nur lesend gemountet)
```

Die **Verwaltung** (`control-api`) hat weder Zugangsdaten zum Sicherungsspeicher noch
Zugriff auf Docker. Sie stellt ein Ziel ein, **löst Aufträge aus** und zeigt
Ergebnisse. Dump, Verschlüsselung, Upload, Aufräumen und Rückspielen führt der
**Backup-Agent** (`apps/backup-agent`, Container `backup-agent`) aus.

**Warum nicht in der Verwaltung?** Die Verwaltung hat eine Weboberfläche, einen
Anmeldeweg und öffentliche Eingangswege. Wer sie kompromittiert, bekäme sonst die
Sicherungen aller Kunden und könnte Instanzen anfassen. Der Agent hat keinen Weg
von außen, kennt nur einen Aufrufer (die Verwaltung, per Signatur) und darf
auf Docker nur das, was die Allowlist erlaubt (Abschnitt 10). Das
verkleinert den Schaden eines Einbruchs in die Verwaltung auf „Aufträge auslösen,
die der Agent ohnehin ausführen würde“.

Der Agent ist **ein** Container im Compose-Stapel der Verwaltung (`docker-compose.yml`):
kein veröffentlichter Port, `read_only`, ohne Linux-Capabilities, mit
`no-new-privileges`, Zustand in einem eigenen Volume (`backup-agent-state`, im
Container `/state`). `install.sh` erzeugt die vier nötigen Geheimnisse:

| Variable | Zweck |
|---|---|
| `BACKUP_AGENT_SECRET` | Schlüssel der Anfragesignatur (HMAC) zwischen Verwaltung und Agent |
| `AGENT_STATE_KEY` | verschlüsselt die Zugangsdaten im State-Volume des Agents (AES-256-GCM) |
| `BACKUP_REPORT_KEY` | Schlüssel, mit dem der Agent bei der Verwaltung den Sicherungsplan abholt und Ergebnisse meldet (Header `x-backup-key`) |
| `BACKUP_DB_PASSWORD` | Passwort der Datenbankrolle `backup_agent` (nur lesen, nur für `pg_dump`, siehe Abschnitt 2). Bei einer bestehenden Installation trägt `install.sh` es beim nächsten Aufruf nach |

Die Verwaltung vergleicht `x-backup-key` mit ihrer Variable **`CONTROL_BACKUP_KEY`**.
Diese muss denselben Wert wie `BACKUP_REPORT_KEY` haben. Tragen Sie ihn in
`installations/<slug>/.env` ein, falls er dort nicht schon steht; ohne diesen Wert
gibt es die beiden Wege `GET /api/internal/backup-plan` und `POST /api/backups` nicht
(404), und der Agent bekommt weder einen Plan noch kann er melden.

**Die Wege `/api/internal/…` gibt es nur im Compose-Netz.** Der Agent ruft die
`control-api` direkt auf (`CONTROL_URL=http://control-api:3001`), nicht über das
öffentliche `control-web`. Dessen nginx beantwortet `/api/internal` mit 404 und reicht
den Header `x-backup-key` nie an die API weiter: Das Rechnungsarchiv liefert
entschlüsselte Rechnungen allein gegen diesen statischen Schlüssel und gehört nicht
an den Rand. Das gilt auch für `POST /api/backups` von außen. Wer die Wege von einem
anderen Rechner aus nutzen will, braucht einen Zugang zum Compose-Netz (z. B. einen
Tunnel), nicht die öffentliche Adresse.

### Wie die Verwaltung den Agent aufruft

HTTP/JSON im internen Netz, Hostname `backup-agent`, Port 8787. **Jede** Anfrage ist
signiert: `X-SI-Timestamp` (ms seit Epoche), `X-SI-Nonce` (mindestens 16 Byte, hex),
`X-SI-Signature` = HMAC-SHA256 über Methode, Pfad mit Query, Zeitstempel, Nonce und
SHA-256 des Bodys. Der Agent lehnt ab:

- einen Zeitstempel, der mehr als 60 Sekunden abweicht,
- eine Nonce, die er in den letzten 5 Minuten schon gesehen hat (Replay),
- eine falsche Signatur (zeitkonstanter Vergleich),
- einen Body über 1 MiB.

Die Aufträge heißen `backup`, `backup-control`, `verify` und `restore`; sie laufen in
einer Warteschlange im Agent, die Verwaltung fragt den Stand ab. Antworten enthalten
keine Geheimnisse. Quelle: `apps/backup-agent/src/hmac.ts`, `app.ts`,
`apps/control/src/backup-settings/`.

## 2. Was gesichert wird und was nicht

| Was | Wie | Ablage im Ziel |
|---|---|---|
| Datenbank je Kundeninstanz | `pg_dump -Fc`, per `docker exec` im Datenbank-Container der Instanz, verschlüsselt | `<Präfix>/instances/<subdomain>/<JJJJ-MM-TT>T<HHMMSS>Z.dump.age` |
| Uploads je Instanz | `tar czf` im Container, der das Volume einhängt, verschlüsselt (nur, wenn das Manifest `uploadsService` und `uploadsPath` nennt) | `….uploads.tar.age` |
| Datenbank der Verwaltung | `pg_dump -Fc` über `CONTROL_DATABASE_URL` (Rolle `backup_agent`, siehe unten), verschlüsselt (age). **Der Dump enthält überwiegend Chiffretext**, siehe unten | `<Präfix>/control/<Zeitstempel>.dump.age` |
| Rechnungsarchiv | je Jahr alle PDFs und XMLs plus `hashes.sha256`, verschlüsselt (age). Der Agent holt sie **über die Verwaltung**, nicht per SQL | `<Präfix>/invoices/<JJJJ>/<Zeitstempel>.tar.age` |

Zu jeder Datei gehört eine `.meta.json` mit Größe und SHA-256. Die
Instanz-Container findet der Agent über Compose-Labels
(`com.docker.compose.project`, `com.docker.compose.service`). Welches Projekt und
welcher Dienst, steht im Manifest unter `provisioning.backup`
([manifest.md](../manifest.md)); **ohne diesen Abschnitt gibt es keinen
Sicherungsplan** und die Verwaltung lehnt Sicherung und Wiederherstellung ab.

**Der Agent liest die Verwaltungsdatenbank mit einer eigenen, schreibgeschützten Rolle.**
Der Dienst `control-db-roles` (ein Einmalauftrag in `docker-compose.yml`, Skript
`ops/control-db/backup-agent-role.sql`) legt bei jedem Start die Rolle `backup_agent` an
bzw. gleicht sie an: kein Superuser, `pg_read_all_data` (genau das, was `pg_dump` liest,
auch für künftige Tabellen) und `default_transaction_read_only`. Auch ein
kompromittierter Agent kann die Datenbank damit nicht ändern oder löschen. Das Passwort
ist `BACKUP_DB_PASSWORD` aus der `.env`; `CONTROL_DATABASE_URL` des Agents baut darauf auf.

**Teilweise gescheiterte Sicherungen.** Scheitert bei einer Instanz nur der Uploads-Teil
(z. B. `tar`), bleibt der bereits hochgeladene Datenbank-Dump liegen: Seine Meta-Datei
trägt `"partial": true` und nennt nur ihn, die Verwaltung bekommt die Meldung, der Auftrag
steht aber als **fehlgeschlagen** („Teilweise gescheitert: …“) im Log des Agents. Es
wird danach nicht aufgeräumt, damit der unvollständige Satz keinen vollständigen
verdrängt. Eine Wiederherstellung daraus spielt nur die Datenbank ein.

**Der Dump der Verwaltung enthält überwiegend Chiffretext.** Personenbezogene Felder und
Rechnungsinhalte liegen verschlüsselt vor (`enc:v1:…`). Im Klartext bleiben festgeschriebene
Rechnungen und Protokolleinträge aus der Zeit vor der Einrichtung des Tresors (per
Datenbank-Trigger unveränderlich; Einstellungen → Sicherheit zeigt die Zahl),
Protokolleinträge, die bei gesperrtem Tresor entstehen (Anmeldungen), und Mitarbeiterkonten. Zur Wiederherstellung der verschlüsselten Felder braucht es die
**Passphrase** (oder eine weitere Passphrase) oder den **Wiederherstellungsschlüssel**
aus der Einrichtung des Tresors. Ohne beides gibt es dafür keinen Weg zurück, auch nicht
für den Betreiber. Zusätzlich zum age-Schlüssel der Sicherungen (Abschnitt 4) gehören sie
in Ihre eigene, getrennte Ablage.

**Das Rechnungsarchiv holt der Agent über die Verwaltung.** Er liest die Datenbank
dafür nicht mehr selbst; `CONTROL_DATABASE_URL` dient nur noch dem `pg_dump`. Er ruft
`GET /api/internal/invoice-archive` ab (Header `x-backup-key`, derselbe Schlüssel wie
beim Sicherungsplan), seitenweise. Die Verwaltung liefert dort **entschlüsselte**
Dokumente mit SHA-256, aber nur im entsperrten Zustand. Der Agent prüft jede Prüfsumme
vor dem Hochladen (bei Abweichung bricht der Lauf ab, nichts Beschädigtes kommt ins
Archiv), verschlüsselt mit age und legt wie bisher mit Object Lock ab. So bleibt das
GoBD-Archiv **auch ohne die Verwaltung lesbar**: mit dem age-Schlüssel, ohne
Tresor-Passphrase. Die Jahreszuordnung folgt dem Jahr der Festschreibung (UTC).

**Was bei gesperrter Verwaltung weiterläuft.** Nach einem Neustart antwortet die
Verwaltung bis zum Entsperren mit 423 (Tresor gesperrt), der Plan-Weg ist aber ausgenommen,
und der Agent ist ohnehin auf Ausfälle vorbereitet:

- **Instanzsicherungen laufen weiter.** Der Agent merkt sich den zuletzt gültigen Plan
  (verschlüsselt im State-Volume, `plan.enc`). Ist der Plan nicht abrufbar (423, Netzfehler,
  Neustart der Verwaltung), sichert er mit diesem Plan weiter und schreibt eine Warnung
  („Sicherungsplan nicht abrufbar; es gilt der zuletzt gültige Plan …“). Instanzen, die seit
  dem letzten erfolgreichen Abruf neu hinzukamen, fehlen bis zum nächsten Abruf. Gibt es noch
  keinen gemerkten Plan, steht eine Fehlerzeile („Instanzen werden diesmal NICHT gesichert“).
- **Die Datenbank der Verwaltung wird weiter gesichert** (der Agent liest sie selbst per
  `pg_dump`, ohne die Verwaltung).
- **Meldungen gehen nicht verloren.** Kann der Agent ein Ergebnis nicht an `POST /api/backups`
  melden (423, Netz, 5xx), legt er die Meldung verschlüsselt im State-Volume ab
  (`pending-reports.enc`, höchstens 500) und reicht sie nach: nach der nächsten erfolgreichen
  Meldung bzw. Planabfrage und spätestens alle 10 Minuten. Eine von der Verwaltung endgültig
  abgelehnte Meldung (4xx) wird verworfen und geloggt.
- **Nur das Rechnungsarchiv wartet.** Es braucht die entsperrte Verwaltung (Klartext der
  Dokumente), siehe unten. `GET /api/internal/backup-plan` und `POST /api/backups` sind bei
  gesperrtem Tresor ausdrücklich erlaubt; der gemerkte Plan und die Meldungswarteschlange
  sind der Rückfall bei Netz- und sonstigen Fehlern.
- **Wiederherstellung** und **Einstellungen** gehen nur bei entsperrter Verwaltung; eine
  Wiederherstellung braucht außerdem einen abrufbaren (oder gemerkten) Plan.

Ist die Verwaltung gesperrt (HTTP 423, etwa nach einem Neustart bis zum Entsperren),
meldet der Agent den Lauf des Rechnungsarchivs als **`deferred`**. Das ist kein Fehler: Der Dump der
Verwaltung ist trotzdem gesichert, nur das Rechnungsarchiv steht noch aus. Der Agent
versucht es danach alle 10 Minuten erneut (ohne neuen Dump), spätestens beim nächsten
Planlauf. Wer eine Verwaltung nach einem Neustart nicht entsperrt, bekommt also kein
neues Rechnungsarchiv.

**Übersprungene Belege.** Kann die Verwaltung einzelne Rechnungen nicht ausliefern
(`skipped` in der Antwort, z. B. nicht entschlüsselbar), legt der Agent den Rest ab, loggt
die betroffenen Nummern und verbucht den Lauf als **fehlgeschlagen** (keine Erfolgsmeldung).
Beim nächsten Lauf fragt er sie erneut an; sind sie dann verfügbar, wird das geänderte
Archiv neu abgelegt.

Das Rechnungsarchiv wird nur neu abgelegt, wenn sich sein Inhalt geändert hat. Ein
gelungener Lauf **ohne neue Dateien** (oder ganz ohne Rechnungen) wird trotzdem als Lauf
gemeldet (Art `invoices`, Datum des Laufs, bei unverändertem Archiv mit Schlüssel und
Prüfsumme des neuesten vorhandenen), damit „Sicherung der Verwaltung überfällig“ nicht
dauerhaft anschlägt, nur weil es keine neuen Rechnungen gibt. Die Verwaltung drosselt den
Abruf (120 Anfragen je Minute); bei HTTP 429 wartet der Agent die Zeit aus `Retry-After`
(sonst 2, 4, 8 … Sekunden, höchstens 2 Minuten) und versucht es bis zu achtmal erneut.
Zusammenhang mit der GoBD: [gobd.md](gobd.md), Abschnitt 9.

**Nicht gesichert wird:**

- **`CONTROL_CONFIG_KEY` und `JWT_SECRET`.** Sie liegen in der `.env` der
  Installation, nicht in der Datenbank. **`CONTROL_CONFIG_KEY` gehört gesondert
  gesichert**, getrennt von den Dumps (Passwortmanager). Er verschlüsselt ruhende
  Geheimnisse in der Datenbank (TOTP-Geheimnisse, Setup- und Kennzahlen-Token der
  Instanzen). Ohne ihn ist ein zurückgespielter Dump in diesen Feldern unlesbar, und
  TOTP müsste neu eingerichtet werden.
- **Die Zugangsdaten zum Sicherungsziel und der Agent-Zustand.** Das State-Volume
  `backup-agent-state` enthält das Ziel (verschlüsselt mit `AGENT_STATE_KEY`) und
  wird nicht gesichert. Gehen Volume oder `AGENT_STATE_KEY` verloren, richten Sie das
  Ziel in den Einstellungen neu ein. Die Sicherungen im Ziel bleiben lesbar, solange
  Sie den privaten Schlüssel haben.
- **Der private Entschlüsselungsschlüssel.** Er liegt absichtlich nirgends auf dem
  Server (Abschnitt 4).
- **Compose-Dateien, `.env`, Manifest, Coolify-Einstellungen, Images.** Das ist
  Konfiguration, kein Datenbestand. Halten Sie sie in Ihrer eigenen Ablage.
- **Eine Demo-Instanz, die sich selbst zurücksetzt.**

## 3. Einrichtung in den Einstellungen

Unter **Einstellungen → Sicherung** (Rollen `owner` und `administrator`, zweiter
Faktor nötig). Die Seite zeigt zuerst, ob der Agent erreichbar ist. Ist er es nicht,
wird nichts gespeichert.

Zugangsdaten sind **write-only**: Sie gehen aus dem Formular durch die Verwaltung
direkt an den Agent. Die Verwaltung speichert sie nicht, schreibt sie weder in
Datenbank noch Audit-Log noch Log und gibt sie nie zurück. In der Datenbank der
Verwaltung stehen nur unkritische Angaben (Typ, Endpunkt oder Host, Bucket oder
Pfad, Zeitplan, Aufbewahrung, Ergebnis des letzten Tests). Der Agent behält bestehende
Zugangsdaten, wenn Sie beim erneuten Speichern ein Geheimnisfeld nicht neu angeben.

### Ziel-Typ S3 (Objektspeicher)

| Feld | Hinweis |
|---|---|
| Endpunkt | mit `https://`, z. B. `https://s3.example.com` |
| Region | wie vom Anbieter genannt |
| Bucket | muss existieren |
| Präfix | optionaler Ordner im Bucket |
| Path-Style | bei vielen selbst betriebenen S3-Diensten nötig |
| Zugangsschlüssel und geheimer Schlüssel | nur Rechte für diesen Bucket vergeben: lesen, schreiben, auflisten; das Recht zum Löschen für die Aufbewahrung alter Sicherungen (Abschnitt 5) und die Löschung archivierter Instanzen nach 90 Tagen (Abschnitt 8) |

**Object Lock am Bucket.** Für das Rechnungsarchiv empfohlen: Legen Sie den Bucket
**mit aktiviertem Object Lock** (und damit Versionierung) an, und setzen Sie in den
Einstellungen „Object Lock“ an. Dann schreibt der Agent jedes Rechnungsarchiv mit
einer Aufbewahrungssperre im Modus GOVERNANCE (Einzelheiten und Grenzen:
[gobd.md](gobd.md), Abschnitt 9). Object Lock lässt sich bei vielen Anbietern nur
beim Anlegen des Buckets einschalten. **„Verbindung testen“ prüft das nicht**, denn
der Test schreibt ein Objekt ohne Sperre. Ob die Sperre greift, sehen Sie nach dem
ersten Lauf in der Verwaltung des Anbieters am Objekt unter `invoices/`. Ein Anbieter
ohne Unterstützung lehnt den Upload mit Sperre ab; dann scheitert der
Rechnungsarchiv-Teil des Laufs mit Fehlermeldung statt still ungeschützt zu laufen.

### Ziel-Typ Storage Box (SFTP)

Gedacht für eine Storage Box (z. B. bei Hetzner), funktioniert mit jedem SFTP-Ziel.

| Feld | Hinweis |
|---|---|
| Host | z. B. `uXXXXXX.your-storagebox.de` |
| Port | **23** bei einer Storage Box (nicht 22) |
| Benutzer | Unterkonto nur für die Sicherungen |
| Anmeldeart | Schlüssel (empfohlen) oder Passwort; Schlüssel als privater Schlüssel im Formular |
| Pfad | Verzeichnis für die Sicherungen, ohne `..` |
| Host-Fingerabdruck (unter „Erweitert“) | optional, `SHA256:…` wie von `ssh-keygen -lf` oder vom Anbieter genannt |

**Host-Key: ohne gepinnten Schlüssel keine Sicherung.** Der Agent verbindet sich nur mit
einem SFTP-Server, dessen Host-Key er kennt (sonst könnte jemand im Netz Passwort und
Sicherungen abgreifen). Tragen Sie den Fingerabdruck ein, oder lassen Sie das Feld leer
und führen Sie „Verbindung testen“ aus: Nur dabei vertraut der Agent dem ersten gesehenen
Schlüssel (Trust on first use) und hält ihn fest (er steht dann in der Anzeige; vergleichen
Sie ihn mit dem Wert Ihres Anbieters). Ohne festgehaltenen Schlüssel scheitern Sicherung,
Prüfung und Wiederherstellung mit der Meldung „SFTP-Host-Key ist nicht gepinnt“. Ändern Sie
Host oder Port, entfällt der Pin; ein anderer Schlüssel am selben Host wird abgelehnt.

**Gespeicherte Zugangsdaten gelten nur für dasselbe Ziel.** Ändern Sie Host, Port oder
Benutzer (Box) bzw. Endpunkt, Bucket oder Zugangsschlüssel-ID (S3), übernimmt der Agent das
gespeicherte Passwort bzw. den geheimen Schlüssel nicht: Sie müssen es erneut eingeben
(„Gib das Passwort erneut ein“). Sonst ließe sich ein Ziel auf einen fremden Host
umbiegen und mit dem alten Geheimnis anmelden.

Bei einer Storage Box gibt es **kein Object Lock** durch den Agent. Schutz des
Rechnungsarchivs entsteht dort durch ein Unterkonto, das nur der Agent nutzt,
und durch Snapshots, die Sie beim Anbieter einrichten.

### Zeitplan und Aufbewahrung

- **Zeitplan:** täglich um 02:30 Uhr oder zusätzlich um 14:30 Uhr (Serverzeit des
  Agents, Zeitzone aus `APP_TIMEZONE`). Ein verpasster Slot wird beim nächsten Takt
  nachgeholt (bis zu 6 Stunden danach), etwa am letzten Märzsonntag, an dem es 02:30 Uhr
  nicht gibt. Nach einem Neustart des Agents läuft nichts sofort los.
- **Zeitlimit und Log:** Jeder Auftrag hat ein Zeitlimit (`JOB_TIMEOUT_MINUTES`, Vorgabe 120);
  danach wird er abgebrochen (Datenströme und `pg_dump` werden beendet) und als
  fehlgeschlagen vermerkt. Jeder gescheiterte oder verschobene Lauf, auch ein geplanter,
  steht mit Auftrag, Art und Grund im Log des Agents (`docker compose logs backup-agent`). Zum Planen holt der Agent die Instanzliste
  von der Verwaltung (`GET /api/internal/backup-plan`) und sichert jede Instanz,
  danach die Verwaltung (Datenbank und Rechnungsarchiv).
- **Aufbewahrung** in Tagen (1 bis 3650): Der Agent räumt Sicherungssätze unter
  `instances/…` und `control/`, die älter sind, **nur nach einem gelungenen Lauf**
  auf und behält immer den neuesten Satz. Er löscht **nie** etwas unter `invoices/`;
  das ist im Agent hart verdrahtet (Löschwächter), unabhängig von Einstellungen.

### Verbindung testen

Der Knopf „Verbindung testen“ lässt den Agent ein Testobjekt schreiben, lesen,
vergleichen und wieder löschen. Das Ergebnis (nur Ja/Nein und ein Text ohne
Geheimnisse) steht in der Verwaltung. Es beweist Zugang und Rechte, **nicht** Object
Lock und nicht, dass der Platz für die Sicherungen reicht. Der Test wird auditiert.

## 4. Der Entschlüsselungsschlüssel

Alle Sicherungen werden mit **age** verschlüsselt (npm-Paket `age-encryption`).
Beim **ersten** Speichern des Ziels erzeugt der Agent ein Schlüsselpaar:

- Der **öffentliche Schlüssel** (Empfänger, `age1…`) bleibt im Agent. Damit lässt sich
  nur verschlüsseln.
- Der **private Schlüssel** (`AGE-SECRET-KEY-1…`) steht **genau einmal** in der Antwort
  auf dieses Speichern, wird in der Oberfläche **einmal angezeigt** und nirgends
  gespeichert, weder im Agent noch in der Verwaltung noch im Log.

**Legen Sie ihn sofort ab:** im Passwortmanager und zusätzlich an einem zweiten Ort
(ausgedruckt im Tresor). **Ohne ihn sind alle Sicherungen wertlos**, auch die
Rechnungsarchive; der Anbieter, die Verwaltung und der Agent können nichts
entschlüsseln. Nach dem Schließen der Anzeige gibt es keinen zweiten Blick. Ändern
Sie später das Ziel, bleibt das Schlüsselpaar bestehen, und es wird kein neuer
privater Schlüssel angezeigt. Wer den Schlüssel verloren hat, leert das Volume
`backup-agent-state` und richtet das Ziel neu ein; dabei entsteht ein neues
Schlüsselpaar, das nur für **neue** Sicherungen gilt. Alte bleiben unlesbar.

Wer den Server übernimmt, kann damit also sichern, aber nichts zurücklesen.

## 5. Sicherungen ansehen, auslösen, prüfen

An der Instanz (Karte der Organisation) gibt es den Bereich **Sicherungen**:

- **Liste:** Datum, Größe, ob geprüft.
- **Jetzt sichern:** löst einen Auftrag `backup` für diese Instanz aus
  (`POST /api/instances/:id/backups`).
- **Prüfen:** löst einen Auftrag `verify` aus. Er lädt die verschlüsselte Datei aus
  dem Ziel und vergleicht **Größe und SHA-256 mit der Meta-Datei**. Er entschlüsselt
  **nicht**. Das beweist, dass die Datei unverändert und vollständig im Ziel liegt, nicht,
  dass sie sich entschlüsseln und zurückspielen lässt (siehe Abschnitt 9).

**Meldeweg und Überfälligkeit.** Nach jedem gelungenen Lauf meldet der Agent
das Ergebnis an `POST /api/backups` (`x-backup-key`): Art (`instance`, `control`
oder `invoices`), Datum, Größe, Objektschlüssel und Prüfsumme. Für Instanzsicherungen
legt die Verwaltung je Instanz und Tag eine Zeile an und erzeugt für eine
**laufende** Instanz die Aufgabe „Sicherung überfällig“, sobald zwei Tage ohne Meldung
vergangen sind. Das Ausbleiben der Meldung ist das Signal; es gibt bewusst keinen
„fehlgeschlagen“-Zustand, denn Sicherungen scheitern in der Praxis mit wochenlanger
Stille. Eigenschaften des Wegs:

- ohne gesetztes `CONTROL_BACKUP_KEY` existiert er nicht (404); falscher oder fehlender
  Schlüssel: 401, Vergleich in konstanter Zeit,
- ein Datum in der Zukunft wird mit 400 abgewiesen (mit einem Tag Toleranz),
- jede formal gültige Meldung bekommt 200, auch mit unbekannter Subdomain
  (kein Aufzählungsorakel),
- höchstens 60 Anfragen je Minute.

Meldungen für die **Verwaltungs-Datenbank** und das **Rechnungsarchiv** haben keine
Instanz; sie landen im Audit-Log (`backup.reported`). Bleibt eine der beiden drei Tage
aus (bei eingerichtetem Ziel), erzeugt die Verwaltung die Aufgabe „Sicherung der Verwaltung
überfällig“. Auch ein Rechnungsarchiv-Lauf ohne neue Dateien zählt als Meldung (siehe
Abschnitt 2). Prüfen Sie zusätzlich ab und zu selbst, dass im Sicherungsziel unter
`control/` täglich ein neuer Satz steht.

## 6. Wiederherstellung in eine NEUE Instanz

**Es gibt keinen Weg, eine laufende Instanz zu überschreiben.** Eine
Wiederherstellung entsteht immer als **neue** Anwendung neben der alten. Das ist
Absicht (Regel R1, siehe [security-model.md](security-model.md)): Ein Fehlgriff darf
nie die Arbeit einer Organisation durch einen Stand von vor Stunden ersetzen.
Die alte Instanz bleibt bis zu Ihrer ausdrücklichen Übernahme unberührt.

**Voraussetzungen:** Der Agent ist erreichbar, das Manifest hat den Abschnitt
`provisioning.backup`, die Instanz hat eine Sicherung mit Status „ok“, und Sie haben
den **privaten Schlüssel** (Abschnitt 4) zur Hand.

**Ablauf** (an der Instanz im Bereich „Sicherungen“, Knopf „Als neue Instanz
wiederherstellen“; `POST /api/instances/:id/restores`):

1. Sie wählen die Sicherung und geben eine **neue Subdomain** ein (sie muss in der
   Verwaltung und in Coolify frei sein), fügen den **privaten Schlüssel** ein, tippen
   zur Bestätigung den **Namen der Instanz** (die Subdomain der bestehenden Instanz)
   ein und weisen sich mit dem zweiten Faktor aus.
2. Die Verwaltung legt über den Provisioner (nur `create`) eine **neue Anwendung** in
   Coolify an, mit denselben Geheimnissen wie die alte, aber ohne eine neue
   Instanz-Zeile. Status `provisioning`.
3. Die Verwaltung beauftragt den Agent mit `restore`; Status `restoring`. Der Agent
   lädt die Dateien, prüft Größe und Prüfsumme gegen die Meta-Datei, entschlüsselt
   im Arbeitsspeicher (ein falscher Schlüssel bricht ab, **bevor** etwas am Ziel
   geändert wird), hält die App-Container des **Ziel**-Stacks an, spielt die
   Datenbank mit `pg_restore --clean --if-exists --no-owner --single-transaction` ein
   (bei einem Fehler bleibt der Stand unverändert), startet die Container wieder und
   entpackt die Uploads.
4. Die Verwaltung prüft die Gesundheit der neuen Instanz. Status `ready`
   („wiederhergestellt, wartet auf Übernahme“) oder `failed` mit lesbarem Grund.

**Der Schlüssel ist write-only:** Er lebt nur im Arbeitsspeicher von Verwaltung und
Agent für die Dauer des Auftrags, wird nie gespeichert, protokolliert oder
zurückgegeben, und Fehlertexte werden davon gesäubert.

**Der Agent stellt nur in einen neuen, fremden Stack zurück und prüft den Auftrag selbst.**
Er vertraut dem signierten Aufruf nicht blind. Er lehnt ab, wenn

- der **age-Schlüssel nicht zu diesem Sicherungsziel gehört** (der daraus berechnete
  öffentliche Schlüssel muss dem Empfänger des Ziels entsprechen; sonst ließe sich mit
  eigenem Schlüssel und eigenem Speicher Beliebiges einspielen),
- das Ziel der eigene Stack des Agents oder der Verwaltung ist, oder wenn er seinen eigenen
  Stack nicht ermitteln kann (er verweigert dann lieber),
- das Ziel auf der **Sperrliste** steht: eingebaut `saas-instant-*` (Verwaltungen, Portal und
  Anmeldedienst portal-auth, so benennt `install.sh` die Projekte), erweiterbar mit
  `RESTORE_DENY_PROJECTS` (Namen oder Präfixe mit `*`, kommagetrennt). Ein Compose-Projektmuster
  für Instanzen darf also nicht mit `saas-instant-` beginnen,
- das Ziel eine **laufende Instanz laut Sicherungsplan** ist (es gibt keinen Weg, eine
  bestehende Instanz zu überschreiben) oder der Plan weder abrufbar noch gemerkt ist,
- der Container nicht das Compose-Projektlabel des Ziels trägt,
- die **Prüfsumme der Sicherung** nicht stimmt: Die Verwaltung gibt im Auftrag die SHA-256
  mit, die der Agent bei der Sicherung gemeldet hat. Der Agent vergleicht sie vor dem
  Herunterladen und Entschlüsseln mit der Meta-Datei und beim Herunterladen mit der Datei. Wer nur
  den Speicher beschreiben kann, kann Datei und Meta-Datei angleichen, nicht aber die
  Meldung in der Verwaltung. Sicherungen ohne gemeldete Prüfsumme (Altbestand) lassen sich
  daher nicht über die Oberfläche zurückspielen. Dasselbe gilt für die **Uploads-Datei**:
  Ihre SHA-256 meldet der Agent mit (`Backup.uploadsSha256`), die Verwaltung gibt sie im
  Auftrag mit, und der Agent prüft das Archiv vor dem Entpacken dagegen; bei Abweichung
  bricht er ab. **Altbestand** ohne Uploads-Prüfsumme: Liegt ein Uploads-Archiv im Speicher,
  wird es **nicht** eingespielt (nur die Datenbank); der Auftrag meldet das im Ergebnis
  (`note`), im Log des Agents und im Hinweis der Wiederherstellung. Sicherungen ohne
  Uploads sind davon nicht betroffen.

**Prüfen Sie die neue Instanz**, bevor Sie übernehmen: unter der neuen Subdomain
anmelden, Stichproben ansehen, das Datum der Sicherung bedenken (alles danach fehlt).

### Übernahme

Erst ein Mensch löst die Übernahme aus
(`POST /api/instances/:id/restores/:restoreId/adopt`, nur im Status `ready`):

1. Die **alte** Anwendung wird per Provisioner **gestoppt, nie gelöscht**. Schlägt das
   Stoppen fehl, bleibt alles unverändert.
2. In einer Transaktion stellt die Verwaltung Subdomain und Coolify-Kennungen der
   Instanz-Zeile auf die wiederhergestellte Anwendung um. Die **alten Werte stehen im
   Audit-Log**.
3. Die alte Anwendung und ihre Daten bleiben in Coolify bestehen. **Löschen Sie sie
   von Hand und erst, wenn die wiederhergestellte Instanz mindestens eine Woche
   unauffällig läuft.** Die Software tut das nie.

**Danach manuell prüfen:** Adresse und Zertifikat der Instanz (die Subdomain
hat sich geändert, ein früher bekannter Link zeigt auf die alte, gestoppte
Anwendung), Weiterleitungen und DNS beim Betreiber, Einträge in der Buchhaltung oder bei
der Kundschaft, die die alte Adresse enthalten. Notieren Sie Anlass, Datum der
zurückgespielten Sicherung und Verlust in einer Notiz an der Organisation.

Jeder Schritt (Start, Ergebnis, Übernahme) steht im Audit-Log.

## 7. Wiederherstellung der Verwaltung selbst (von Hand)

Die Verwaltung hat genau eine Datenbank (`control`, Dienst `control-db`) und
spielt sich nicht selbst zurück: Der Agent liest sie nur für die Sicherung.
Das Zurückspielen geschieht auf dem Server, von Hand, auf dem Rechner des Betreibers,
auf dem der private Schlüssel liegt.

1. Sicherung holen: aus `<Präfix>/control/` den gewünschten Satz
   (`….dump.age`) und die `.meta.json`. Größe und SHA-256 gegen die Meta-Datei
   vergleichen.
2. **Auf dem Rechner des Betreibers entschlüsseln** (`age --decrypt -i <schlüsseldatei>`);
   mit `pg_restore --list` das Inhaltsverzeichnis prüfen.
3. `docker compose stop control-api control-web backup-agent` (nur die Dienste, die
   schreiben; die Datenbank läuft weiter). Der Dienst des Agents heißt
   `backup-agent`.
4. **Aktuellen Stand sichern**, bevor er überschrieben wird. Auch ein kaputter Stand ist
   die einzige Kopie dessen, was seit der letzten Sicherung geschah.
5. In eine Nebendatenbank einspielen und dort nachsehen:
   ```bash
   docker compose exec control-db psql -U control -d postgres -c 'CREATE DATABASE restore_check;'
   docker compose exec -T control-db pg_restore -U control --no-owner --exit-on-error \
     -d restore_check < control.dump
   ```
   Zeilenzahlen wichtiger Tabellen und das jüngste Datum prüfen.
6. Umschalten: `ALTER DATABASE control RENAME TO before_restore;` und
   `ALTER DATABASE restore_check RENAME TO control;` (vorher alle Verbindungen
   beenden). `before_restore` bleibt stehen und wird erst nach einer Woche
   unauffälligem Betrieb von Hand gelöscht.
7. **Denselben `CONTROL_CONFIG_KEY` wie beim Erzeugen der Sicherung verwenden.** Ein
   anderer macht verschlüsselte Felder unlesbar.
8. `docker compose start control-api control-web backup-agent`. Die Migrationen laufen
   beim Start. Dann Anmeldung, Rechnungsliste und Audit-Log ansehen.

Die Verwaltungs-Datenbank enthält die festgeschriebenen Rechnungen samt PDF und XML,
**als Chiffretext**: Nach dem Zurückspielen muss die Verwaltung mit Passphrase oder
Wiederherstellungsschlüssel entsperrt werden. Zusätzlich liegen die Rechnungen im
Klartext-Format (PDF/XML) im Rechnungsarchiv, lesbar nur mit dem age-Schlüssel; der
Wiederherstellungsweg dafür ist:
`invoices/<Jahr>/…tar.age` entschlüsseln, entpacken, `sha256sum -c hashes.sha256`.
Im Modus `portal` hat jede Verwaltung eine eigene Datenbank; die Wiederherstellung
einer betrifft nie eine andere.

## 8. Was die Verwaltung beim Archivieren tut

Beim **Archivieren** einer Instanz stoppt die Verwaltung sie und schreibt in den
Verlauf, wie es um die letzte Sicherung steht. Sie zieht dabei keine Sicherung. Ist
die letzte zu alt oder fehlt sie, steht dort ein Warnhinweis. Lösen Sie vorher einmal
„Jetzt sichern“ aus und prüfen Sie, dass im Verlauf „Letzte Sicherung: heute“ steht.

**Löschung nach 90 Tagen.** Bis dahin bleiben Anwendung (gestoppt), Volume und alle
Sicherungen bestehen; eine Wiederherstellung als neue Instanz ist möglich. Gelöscht wird
nur, wenn die Organisation seit mindestens 90 Tagen den Status „Beendet“ hat (`endedAt`;
ein Wechsel weg von „Beendet“ setzt die Frist zurück) **und** die Instanz seit 90 Tagen
archiviert ist. Eine Instanz einer nicht beendeten Organisation wird nie gelöscht; sie
erscheint nach der Frist als Aufgabe „Löschung fehlgeschlagen“. Sind beide Fristen um, löscht die Verwaltung die Instanz automatisch (Abschnitt
„Regel R1“ in [architecture.md](../architecture.md)). Für den Sicherungsweg heißt das:
Nach der Löschung der Coolify-Anwendung nennt der Sicherungsplan die Subdomain unter
`purge`; der Agent löscht beim nächsten Lauf (02:30, bei „zweimal täglich“ auch 14:30) **alles** unter
`instances/<subdomain>/`, auch den neuesten Satz, und meldet `purged`. Erst diese
Meldung gibt der Verwaltung frei, ihre Zeilen zu löschen. `invoices/` fasst er nie an;
auch das Rechnungsarchiv der Verwaltung bleibt unverändert. Ein Agent ohne `purge`-
Unterstützung (älter als 1.2.0) bestätigt nie: Die Löschung hängt dann sichtbar als
Aufgabe „Löschung fehlgeschlagen“, es geht nichts verloren.
**Der Zugang zum Sicherungsziel braucht dafür das Recht zum Löschen** (Abschnitt 3).

## 9. Die Übung, die dieses Dokument nicht ersetzt

**Eine Sicherung, die nie zurückgespielt wurde, ist eine Vermutung.** Die Prüfung in
der Verwaltung (Abschnitt 5) ist eine **Prüfsumme**: Sie erkennt Beschädigung und
fehlende Dateien, nicht einen falschen Schlüssel, ein leeres Archiv oder einen Dump,
der sich nicht einspielen lässt. Ein Entschlüsselungstest ist ohne den privaten
Schlüssel nicht möglich, und der Schlüssel liegt aus gutem Grund nicht auf dem
Server. Deshalb **regelmäßig** (mindestens vierteljährlich) und vor dem ersten echten
Kunden:

1. Eine aktuelle Sicherung einer Wegwerf-Instanz mit dem privaten Schlüssel als neue
   Instanz wiederherstellen (Abschnitt 6) und die Daten ansehen: Zeilenzahlen,
   jüngstes Datum, ein Upload öffnen.
2. Den Dump der Verwaltung auf dem eigenen Rechner entschlüsseln und in einen
   Wegwerf-Postgres einspielen (`pg_restore --exit-on-error`); Zeilenzahlen mit der
   laufenden Datenbank vergleichen.
3. Ein Rechnungsarchiv entschlüsseln und `sha256sum -c hashes.sha256` ausführen.
4. Gegenprobe: Mit einem fremden Schlüssel darf sich keine Datei öffnen lassen, und
   auf dem Server darf kein privater Schlüssel liegen.
5. Einmal den ganzen Weg samt Übernahme an einer Wegwerf-Instanz gehen und das
   Ergebnis im Betriebsjournal festhalten. Abweichungen von dieser Anleitung gehören
   hierher.

## 10. Das Risiko des Docker-Zugriffs

Der Agent muss in Datenbank-Container fremder Stacks `pg_dump`, `pg_restore` und
`tar` ausführen. Dafür braucht er Docker-Zugriff. **Dieser Zugriff ist im Kern
ein Zugriff auf den Server.**

Gelöst ist das so, mit begrenztem Schaden:

- Der Agent spricht nie mit `docker.sock`, sondern mit dem Dienst
  **`docker-socket-proxy`** (`tcp://docker-socket-proxy:2375`). Nur dieser Dienst
  mountet den Socket (lesend gemountet) und lauscht nur im internen Netz
  `docker-api`, an dem sonst nur der Agent hängt.
- Die Allowlist steht in `ops/docker-proxy/haproxy.cfg.template` (eigene Regeln, nicht die
  Schalter des Images: `POST=1` mit `CONTAINERS=1` erlaubte auch `/containers/create` und
  `DELETE`). Erlaubt sind genau sieben Aufrufe: `GET /containers/json`,
  `GET /containers/<id>/json`, `POST /containers/<id>/start`, `…/stop`, `…/exec`,
  `POST /exec/<id>/start` und `GET /exec/<id>/json`. Alles andere (Container anlegen,
  beenden, löschen, Images, Volumes, Netze, System …) bekommt 403. Ein Test
  (`tests/install.test.sh`) hält das fest.
- Der Agent bedient nur Container mit dem erwarteten Compose-Label und startet und
  stoppt nur Container des Ziel-Stacks.

**Was bleibt:** `exec` und `start`/`stop` erlauben im Prinzip, in **jedem** Container
auf dem Host Befehle auszuführen. Wer den Agent kompromittiert, kann das gesamte
Docker-Host-System beeinflussen, auch wenn der Agent selbst es nie tut. Der
Proxy begrenzt die Schnittstelle, er macht sie nicht harmlos. Deshalb: den Agent
nicht aus dem Netz erreichbar machen (kein `ports:`), `BACKUP_AGENT_SECRET` wie ein
Passwort behandeln, den Server aktuell halten, und wo es geht den Agent auf einem
Host betreiben, der nur die Verwaltung und die Instanzen trägt. Die Verwaltung selbst
hat keinen Docker-Zugriff.

## 11. Zusammenfassung der Rechte

| Wer | darf | darf nicht |
|---|---|---|
| Verwaltung | Ziel einstellen (write-only), Aufträge `backup`, `verify`, `restore` auslösen, neue Anwendung anlegen, alte **stoppen**, 90 Tage nach der Archivierung die Coolify-Anwendung löschen, Meldungen annehmen | Zugangsdaten halten oder zurückgeben, Dump oder Restore selbst ausführen, Docker ansprechen, im Sicherungsziel löschen |
| Agent | sichern, auflisten, prüfen, in einen **fremden, neuen** Stack zurückspielen, eigene alte Sicherungen nach gelungenem Lauf aufräumen, `instances/<subdomain>/` einer archivierten Instanz nach Ablauf der Frist löschen und es melden | Instanzen oder Datenbanken löschen, `invoices/` löschen, in den eigenen Stack oder den der Verwaltung zurückspielen, ohne Signatur antworten |
| Betreiber | Schlüssel verwalten, Rückspielproben, alte Anwendungen von Hand entfernen | |
