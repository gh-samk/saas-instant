# Architektur

Aufbau von saas-instant, soweit er für Betrieb und Anbindung einer eigenen Software wichtig ist. Aussagen sind am Code geprüft; Dateinamen stehen dabei, wo sich Nachlesen lohnt.

## Bausteine

```
Repository
├── apps/control     Verwaltung: NestJS-API (Prisma, Postgres) + React-Oberfläche (Vite)
├── apps/portal      Portal: statische Seite (nginx), liest portal/registry.json
├── packages/shared  gemeinsamer Code (Datum, Mailrahmen, Organisationsname ...)
├── packages/ui      gemeinsame UI-Bausteine
├── docker-compose.yml             Control-Stack einer Verwaltung
├── docker-compose.coolify.yml     Vorlage der INSTANZ (Vertrag, nicht Ihre Software)
├── saas-instant.manifest.example.yaml
├── install.sh, bin/saas-instant   Installation und Betrieb
└── reference/                     Vorlagen und Referenz (Coolify-Compose der Verwaltung, Provisionierungsskript)
```

Eine laufende Verwaltung besteht aus drei Containern:

| Dienst | Aufgabe |
|---|---|
| `control-db` | Postgres 16, genau eine Datenbank `control` |
| `control-api` | NestJS-Anwendung; beim Start `prisma migrate deploy`, dann die API unter dem Präfix `/api` |
| `control-web` | nginx: liefert die Oberfläche aus und proxyt `/api/` an `control-api:3001`. Er ist der einzige veröffentlichte Dienst. |

Der Compose-Dienstname `control-api` ist fest; eine Prüfung (`timezone.spec.ts`) verlässt sich darauf.

## Eine Verwaltung je Software

Eine Verwaltung kennt genau eine Software. Name, Mail-Absender, Preisstufen, Aussteller der Rechnungen und die Anbindung der Instanzen kommen aus dem [Manifest](manifest.md) dieser Software. Wer zwei Softwareprodukte betreibt, betreibt zwei Verwaltungen mit je eigener Datenbank und je eigener Anmeldung; es gibt keine gemeinsamen Daten zwischen ihnen.

Jede Verwaltung läuft als eigenes Compose-Projekt (`COMPOSE_PROJECT_NAME=saas-instant-<slug>`), damit Datenbank-Volume, Netz und Container getrennt bleiben, mit eigenem Port und eigener `.env` unter `installations/<slug>/`.

## Modi: `single` und `portal`

Der Modus wird bei der Erstinstallation festgelegt und in `.saas-instant-mode` festgeschrieben (`install.sh` und `bin/saas-instant` lesen die Datei; sie hat Rechte 444). Er ist danach unveränderlich: `install.sh` verweigert einen abweichenden Modus mit einer Fehlermeldung.

- **`single`:** genau eine Verwaltung. Eine zweite Installation unter demselben Wurzelverzeichnis lehnt `install.sh` ab.
- **`portal`:** beliebig viele Verwaltungen (`bin/saas-instant add <slug>`) und ein Portal. Das Portal ist eine statische Seite ohne Anmeldung und ohne Kundendaten. Es lädt `registry.json` (Einträge mit `slug`, `name`, `url`), zeigt je Eintrag eine Karte und verlinkt nur auf `http`/`https`-Adressen. Der Container läuft schreibgeschützt, ohne Linux-Capabilities und mit `no-new-privileges`. `install.sh` erzeugt die `registry.json` aus den `.env`-Dateien und den Manifesten der Verwaltungen; die Adressen sind dabei `http://<host>:<port>` (siehe Einschränkungen im README).

Die Anmeldung gehört der einzelnen Verwaltung. Das Portal ist kein Single-Sign-On.

## Provisioner

Die Verwaltung weiß nicht, wie eine Instanz entsteht, nur dass es einen Anbieter gibt, der drei Dinge kann (`apps/control/src/provisioning/provisioner.ts`):

| Operation | Wirkung |
|---|---|
| `create(request, hooks)` | Instanz anlegen: Anwendung erzeugen, Umgebung setzen, Domain hängen, ausrollen; kehrt zurück, wenn das Ausrollen durch ist, oder wirft `ProvisioningFailedError` mit lesbarem Grund |
| `status()` / `status(ref)` | Auskunft über alle bzw. eine Instanz; `null`, wenn der Anbieter sie nicht kennt |
| `stop(ref)` | Instanz stoppen; die Daten bleiben bestehen |

Es gibt in v1 genau einen Anbieter, `CoolifyProvisioner` (`apps/control/src/coolify/`). Ein zweiter Anbieter hängt an derselben Schnittstelle. Hinweis: Auch Teile außerhalb von `coolify/` nutzen noch Coolify-Begriffe und -Konfiguration (etwa die Verfügbarkeitsprüfung der Subdomain und das Feld `coolifyApplicationId` im Datenmodell); ein zweiter Anbieter braucht daher mehr als eine neue Klasse.

Ablauf des Coolify-Anbieters bei `create`: Anwendung anlegen (die Referenz, bei Coolify die UUID, wird sofort festgehalten), Umgebungsvariablen setzen, ein erstes Mal ausrollen (Coolify liest dabei die Compose-Datei), Domain setzen (bei Coolifys Antwort „ohne Compose-Datei“ mit Geduld wiederholt), Quellstand festhalten, ein zweites Mal ausrollen. Zeitgrenze je Ausrollen 600 s.

Ablauf aus Sicht der Verwaltung (`InstanceService`, `InstanceProvisioningService`): Eine Organisation hat **höchstens eine** Instanz. Die Subdomain wird vor dem Anlegen gegen die Datenbank und gegen Coolify auf Verfügbarkeit geprüft; eine Vorschau (gültig 15 Minuten) zeigt vorab, was angelegt würde. Das Anlegen läuft im Hintergrund, der Fortschritt steht in der Instanzkarte. Danach wartet die Verwaltung auf die Gesundheitsprüfung der Instanz (`healthPath`) und setzt sie erst dann von `provisioning` auf `active`. Hängt eine Erstellung länger als 15 Minuten, gilt sie als festgefahren.

Jede neue Instanz bekommt **frische Zufallsgeheimnisse**, nichts wird zwischen Kunden geteilt, dazu die Variablen des [Instanz-Vertrags](instance-contract.md). Fehlen die SMTP-Daten für Instanzen, wird in Coolify gar nichts angelegt.

## Regel R1: nie löschen

> Die Verwaltung kennt genau eine Datenbank (`control`). Es gibt keine zweite `DATABASE_URL`, keinen SQL-Zugang zu Kundeninstanzen und keinen Codepfad, der ein Deployment oder eine Datenbank löscht.

Wie das gesichert ist:

- Die Provisioner-Schnittstelle hat keine Methode zum Löschen oder Zurücksetzen. Was dort nicht steht, lässt sich nirgends aufrufen.
- `coolify/no-delete-path.spec.ts` prüft über den Quellbaum: abschließende Methodenliste des Clients, kein HTTP-DELETE und kein Löschaufruf in den Dateien, die Coolify ansprechen, kein Löschaufruf gegen die Beweismodelle (Instanz, Kennzahl, Sicherung, Audit-Log).
- **Archivieren** stoppt die Anwendung und setzt den Status auf `archived`; das Datenvolumen bleibt. Der Meldetext nennt den Stand der letzten Sicherung, löst aber keine aus. Es gibt keinen Weg zurück im Code, die Wiederherstellung ist ein Handgriff in Coolify.
- **Erstellung verwerfen** ist nur unter vier Bedingungen möglich: Status `provisioning`; in Coolify existiert nichts (nie angelegt oder dort von Hand entfernt, ein Ausfall zählt nicht als entfernt); keine Kennzahlen; keine Sicherungen. Sie löscht nur die Zeile in der eigenen Datenbank.
- Das Coolify-Token sollte **kein Löschrecht** haben (siehe [installation.md](installation.md)).

Weitere Regeln, die im Code genannt und geprüft werden: **R2** der Rechnungsnummernkreis ist lückenlos (Nummer erst beim Festschreiben, in derselben Transaktion, mit Sperre; Format `JJJJ-NNN`); **R4** nichts wird automatisch gelöscht (einzige Ausnahme: unbestätigte Mail-Eintragungen werden nach 72 Stunden entfernt, mit Audit-Eintrag); **R5** alles mit Geldfolge wird vorgeschlagen, nicht vollzogen (der Zeitplan vollzieht nur zwei Statuswechsel ohne Geldfolge); **R3** werbliche Mail geht nur durch ein Tor, das die Einwilligung prüft.

## Manifest

Das Manifest ist die einzige Stelle, an der die Verwaltung etwas über die Software erfährt. Fünf Abschnitte: `product`, `mail`, `billing`, `provisioning`, `ui`. Der `ManifestService` lädt es einmal beim Start und prüft alles von Hand; Fehler werden gesammelt und verhindern den Start. Umgebungsvariablen überschreiben Manifest-Werte, wo das dokumentiert ist; das Manifest überschreibt neutrale Vorgaben. Felder: [manifest.md](manifest.md).

## Instanz-Vertrag

Eine Software wird verwaltbar, wenn jede Instanz

- die Variablen `APP_URL`, `SETUP_TOKEN`, `METRICS_TOKEN` (und die weiteren Grundwerte) entgegennimmt,
- einen Gesundheits-Endpunkt (`healthPath`) bietet,
- optional einen Setup-Status (`setupStatusPath`), einen Einrichtungslink (`setupPath?token=`) und einen Kennzahlen-Endpunkt (`metricsPath`, Bearer-Token) bietet.

Nicht deklarierte optionale Endpunkte werden nie aufgerufen. Vollständig: [instance-contract.md](instance-contract.md).

## Datenmodell

Die Verwaltung speichert in ihrer eigenen Postgres-Datenbank (Prisma, `apps/control/prisma/schema.prisma`) unter anderem: `User`, `PasskeyCredential`, `RecoveryCode`, `Device`, `Company` (Organisation), `Instance`, `Backup`, `Metric`, `ReconciliationRun`, `InstancePreview`, `Note`, `Invoice`/`InvoiceLine`, `MailTemplate`/`MailDelivery`, `Consent`, `Inquiry`, `IntakeAccess`, `FeatureFlag`, `AuditLog`. Tabellen und Spalten heißen wie Modelle und Felder (kein `@map`). Fachliche Daten sind `@db.Date`, technische Zeitstempel `DateTime`.

Geheimnisse, die die Verwaltung später braucht (TOTP-Geheimnisse, Setup- und Kennzahlen-Token je Instanz), liegen mit AES-256-GCM verschlüsselt in der Datenbank; der Schlüssel ist `CONTROL_CONFIG_KEY`.

## Laufende Aufgaben im Hintergrund

| Wann | Was | Abschaltbar mit |
|---|---|---|
| täglich 03:00 | Zeitplan: zwei Statuswechsel ohne Geldfolge | `CONTROL_SCHEDULE_ENABLED=nein` |
| täglich 04:00 | Kennzahlen aller aktiven Instanzen abrufen (nur wenn `metricsPath` deklariert) | `CONTROL_METRICS_FETCH_ENABLED=nein` |
| täglich 04:30 | Abgleich mit Coolify; Abweichungen erscheinen in der Aufgabenliste | `CONTROL_RECONCILIATION_ENABLED=nein` |
| minütlich | Versand der Rundmail-Warteschlange | `CONTROL_BROADCAST_ENABLED` |
| stündlich | Prüfung des Postausgangs; Aufräumen unbestätigter Einwilligungen | `CONTROL_OUTBOX_PROBE_ENABLED`, `CONTROL_CONSENT_CLEANUP` |

Die Uhrzeiten gelten in der Zeitzone des Containers (`APP_TIMEZONE`, Vorgabe `Europe/Berlin`).

## Sicherheit in Kürze

- Anmeldung: Passkey oder Passwort plus zweiter Faktor; mindestens ein Faktor muss eingerichtet bleiben (serverseitig erzwungen). Sitzung 30 Tage, Cookie `httpOnly`, `SameSite=Strict`, CSRF per Double-Submit (`x-csrf-token` gegen Cookie).
- Rate-Limit global 100 Anfragen je Minute, an den Anmelderouten und am öffentlichen Anfrageweg strenger.
- Server-zu-Server-Wege (Anfrageweg, Sicherungsmeldung) sind per Schlüssel geschützt (`CONTROL_INQUIRY_KEY`, `CONTROL_BACKUP_KEY`) und von der CSRF-Prüfung ausgenommen; jede Ausnahme ist im Code begründet und wird von einem Test aufgezählt.
- Logs maskieren Token in Pfaden (Aufnahmelinks, Einwilligungslinks, Notfall-Links), im Anwendungs- wie im nginx-Zugriffslog.
- Notfallzugang nur im Container über `node dist/cli/emergency.js`; er erzeugt Links (15 Minuten), nie Passwörter, und schreibt ins Audit-Log mit Akteur `cli:<OS-Benutzer>`.

## Was nicht dazugehört

- Die verwaltete Software selbst und ihr Instanz-Image. `docker-compose.coolify.yml` ist eine Vorlage, deren Image-Quellen Sie anpassen müssen.
- Ein zweiter Provisioner und weitere Sprachen für Backend- und Mailtexte (v1).
