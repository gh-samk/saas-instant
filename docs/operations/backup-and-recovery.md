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
Container `/state`). `install.sh` erzeugt die drei nötigen Geheimnisse:

| Variable | Zweck |
|---|---|
| `BACKUP_AGENT_SECRET` | Schlüssel der Anfragesignatur (HMAC) zwischen Verwaltung und Agent |
| `AGENT_STATE_KEY` | verschlüsselt die Zugangsdaten im State-Volume des Agents (AES-256-GCM) |
| `BACKUP_REPORT_KEY` | Schlüssel, mit dem der Agent bei der Verwaltung den Sicherungsplan abholt und Ergebnisse meldet (Header `x-backup-key`) |

Die Verwaltung vergleicht `x-backup-key` mit ihrer Variable **`CONTROL_BACKUP_KEY`**.
Diese muss denselben Wert wie `BACKUP_REPORT_KEY` haben. Tragen Sie ihn in
`installations/<slug>/.env` ein, falls er dort nicht schon steht; ohne diesen Wert
gibt es die beiden Wege `GET /api/internal/backup-plan` und `POST /api/backups` nicht
(404), und der Agent bekommt weder einen Plan noch kann er melden.

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
| Datenbank der Verwaltung | `pg_dump -Fc` über `CONTROL_DATABASE_URL`, verschlüsselt (age). **Der Dump enthält Chiffretext**, siehe unten | `<Präfix>/control/<Zeitstempel>.dump.age` |
| Rechnungsarchiv | je Jahr alle PDFs und XMLs plus `hashes.sha256`, verschlüsselt (age). Der Agent holt sie **über die Verwaltung**, nicht per SQL | `<Präfix>/invoices/<JJJJ>/<Zeitstempel>.tar.age` |

Zu jeder Datei gehört eine `.meta.json` mit Größe und SHA-256. Die
Instanz-Container findet der Agent über Compose-Labels
(`com.docker.compose.project`, `com.docker.compose.service`). Welches Projekt und
welcher Dienst, steht im Manifest unter `provisioning.backup`
([manifest.md](../manifest.md)); **ohne diesen Abschnitt gibt es keinen
Sicherungsplan** und die Verwaltung lehnt Sicherung und Wiederherstellung ab.

**Der Dump der Verwaltung enthält Chiffretext.** Personenbezogene Felder und
Rechnungsinhalte liegen in der Datenbank verschlüsselt (`enc:v1:…`); ein
zurückgespielter Dump ist ohne den Tresorschlüssel in diesen Feldern unlesbar. Zur
Wiederherstellung braucht es die **Passphrase** (oder eine weitere Passphrase) oder
den **Wiederherstellungsschlüssel** aus der Einrichtung des Tresors. Ohne beides gibt
es keinen Weg zurück, auch nicht für den Betreiber. Zusätzlich zum age-Schlüssel der
Sicherungen (Abschnitt 4) gehören sie in Ihre eigene, getrennte Ablage.

**Das Rechnungsarchiv holt der Agent über die Verwaltung.** Er liest die Datenbank
dafür nicht mehr selbst; `CONTROL_DATABASE_URL` dient nur noch dem `pg_dump`. Er ruft
`GET /api/internal/invoice-archive` ab (Header `x-backup-key`, derselbe Schlüssel wie
beim Sicherungsplan), seitenweise. Die Verwaltung liefert dort **entschlüsselte**
Dokumente mit SHA-256, aber nur im entsperrten Zustand. Der Agent prüft jede Prüfsumme
vor dem Hochladen (bei Abweichung bricht der Lauf ab, nichts Beschädigtes kommt ins
Archiv), verschlüsselt mit age und legt wie bisher mit Object Lock ab. So bleibt das
GoBD-Archiv **auch ohne die Verwaltung lesbar**: mit dem age-Schlüssel, ohne
Tresor-Passphrase. Die Jahreszuordnung folgt dem Jahr der Festschreibung (UTC).

Ist die Verwaltung gesperrt (HTTP 423, etwa nach einem Neustart bis zum Entsperren),
meldet der Agent den Lauf als **`deferred`**. Das ist kein Fehler: Der Dump der
Verwaltung ist trotzdem gesichert, nur das Rechnungsarchiv steht noch aus. Der Agent
versucht es danach alle 10 Minuten erneut (ohne neuen Dump), spätestens beim nächsten
Planlauf. Wer eine Verwaltung nach einem Neustart nicht entsperrt, bekommt also kein
neues Rechnungsarchiv.

Das Rechnungsarchiv wird nur neu abgelegt, wenn sich sein Inhalt geändert hat.
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
| Zugangsschlüssel und geheimer Schlüssel | nur Rechte für diesen Bucket vergeben: lesen, schreiben, auflisten; das Recht zum Löschen nur, wenn die Aufbewahrung alter Sicherungen aufräumen soll (Abschnitt 5) |

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

Bei einer Storage Box gibt es **kein Object Lock** durch den Agent. Schutz des
Rechnungsarchivs entsteht dort durch ein Unterkonto, das nur der Agent nutzt,
und durch Snapshots, die Sie beim Anbieter einrichten.

### Zeitplan und Aufbewahrung

- **Zeitplan:** täglich um 02:30 Uhr oder zusätzlich um 14:30 Uhr (Serverzeit des
  Agents, Zeitzone aus `APP_TIMEZONE`). Zum Planen holt der Agent die Instanzliste
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
Instanz; sie landen nur im Audit-Log (`backup.reported`) und lösen keine Aufgabe aus.
Überwachen Sie diese beiden deshalb selbst: Im Sicherungsziel muss unter `control/`
täglich ein neuer Satz stehen.

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

**Der Agent stellt nur in einen fremden Stack zurück.** Er lehnt ab, wenn das
Ziel der eigene Stack des Agents oder der Verwaltung ist, wenn er seinen eigenen
Stack nicht ermitteln kann (er verweigert dann lieber) oder wenn der Container nicht
das Compose-Projektlabel des Ziels trägt.

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
- Die Allowlist des Proxys erlaubt `CONTAINERS`, `EXEC` und `POST` (für Starten,
  Stoppen und `exec`); `IMAGES`, `NETWORKS`, `VOLUMES`, `SERVICES`, `SWARM`, `TASKS`,
  `SECRETS`, `CONFIGS`, `BUILD`, `SYSTEM` und weitere sind gesperrt. Ein Test
  (`tests/install.test.sh`) hält diese Zeilen fest.
- Der Agent bedient nur Container mit dem erwarteten Compose-Label und startet und
  stoppt nur Container des Ziel-Stacks.

**Was bleibt:** `CONTAINERS` plus `EXEC` erlauben im Prinzip, in **jedem** Container
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
| Verwaltung | Ziel einstellen (write-only), Aufträge `backup`, `verify`, `restore` auslösen, neue Anwendung anlegen, alte **stoppen**, Meldungen annehmen | Zugangsdaten halten oder zurückgeben, Dump oder Restore selbst ausführen, Docker ansprechen, löschen |
| Agent | sichern, auflisten, prüfen, in einen **fremden, neuen** Stack zurückspielen, eigene alte Sicherungen nach gelungenem Lauf aufräumen | Instanzen oder Datenbanken löschen, `invoices/` löschen, in den eigenen Stack oder den der Verwaltung zurückspielen, ohne Signatur antworten |
| Betreiber | Schlüssel verwalten, Rückspielproben, alte Anwendungen von Hand entfernen | |
