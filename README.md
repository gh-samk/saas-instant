# saas-instant

Selbst-hostbare Verwaltung für SaaS-Software, die pro Kunde eine eigene Instanz betreibt: Kunden bzw. Organisationen, ihre Instanzen und ihre Rechnungen an einer Stelle.

*English version: [README.en.md](README.en.md)*

## Was es ist

saas-instant ist eine Web-Anwendung für den Betreiber einer SaaS-Software. Sie hält fest, wer Kunde ist, legt für jeden Kunden eine eigene Instanz der Software an (derzeit über Coolify), beobachtet diese Instanzen und stellt Rechnungen aus. Die Software selbst, die verwaltet wird, ist nicht Teil dieses Repositories. Sie wird über ein Manifest (Produktname, Mail, Abrechnung, Provisionierung) und einen schmalen Instanz-Vertrag angebunden.

Es gibt keine Mandantenfähigkeit in der Verwaltung selbst: Jede Verwaltung gehört genau einer Software und hat eine eigene Datenbank und eigene Benutzer.

## Für wen

Für Betreiber, die eine eigene SaaS-Software in einer Instanz pro Kunde anbieten, Coolify einsetzen und sich Kundenstamm, Instanzen und Abrechnung nicht aus mehreren Werkzeugen zusammensuchen wollen. Wer eine gemeinsame Mandanten-Datenbank betreibt oder nicht mit Coolify arbeitet, kann das in v1 nicht nutzen (siehe Einschränkungen).

## Funktionsumfang

Alle Punkte sind im Code vorhanden; ob sie in Ihrer Umgebung laufen, hängt von Konfiguration ab (Coolify-Zugang, Postausgang, Rechnungsdienst).

- **Organisationen:** Stammdaten, Ansprechpersonen, Notizen, Verlauf, Statuslauf (Anfrage, Demo, Pilot, zahlend, Überprüfung, ruhend, beendet). Ein täglicher Zeitplan (03:00 Uhr, abschaltbar) vollzieht genau zwei Wechsel ohne Geldfolge von selbst (Pilot nach 90 Tagen zu „zahlend“, Überprüfung sieben Monate nach der Pilotentscheidung); alles mit Geldfolge wird nur vorgeschlagen.
- **Anfrage und Aufnahme:** öffentlicher Anfrageweg (`POST /api/public/inquiry`, durch Schlüssel geschützt) und ein Aufnahmeformular per Token-Link für Kundenangaben und Lastschriftmandat.
- **Instanzen:** anlegen über den Provisioner (Vorschau, Fortschritt, Gesundheitsprüfung), Einladungslink für das Erst-Setup, Erreichbarkeitsprüfung, nächtlicher Kennzahlenabruf, nächtlicher Abgleich mit Coolify, Eingang von Sicherungsmeldungen (`POST /api/backups`), Archivieren (Stoppen).
- **Rechnungen:** Preisstufen aus dem Manifest, Entwurf, Festschreiben (danach unveränderlich), Versand per Mail, Mahnung, Zahlungserfassung, Storno, Nummernkreis. XML nach EN 16931 (CII) entsteht im Backend; das PDF/A-3-Dokument erzeugt der Dienst `invoice-renderer` (Quelle `tools/invoice-renderer`, läuft im Compose-Stapel).
- **Mail:** Postausgang mit Warteschlange, getrennt in Transaktionsmails und werbliche Rundmails; Rundmails nur mit Einwilligung (Double-Opt-in, Sperrliste).
- **Aufgabenliste „Heute“:** abgeleitete Hinweise (überfällige Rechnungen, fehlende Sicherung, fehlgeschlagener Kennzahlenabruf, Abweichung zu Coolify usw.).
- **Betriebsschalter:** Feature-Flags, die Instanzen über `GET /api/flags` lesen.
- **Anmeldung:** Passkey oder Passwort mit zweitem Faktor (E-Mail-Code, Authenticator-App oder Passkey), Wiederherstellungscodes, Audit- und Sicherheitslog, Notfallkommandos im Container. Rollen: `owner` und `administrator`.

## Screenshots

Aufgenommen mit den frei erfundenen Demo-Daten aus `pnpm --filter @saas-instant/control seed:demo` (siehe [CONTRIBUTING.md](CONTRIBUTING.md)).

| | |
|---|---|
| ![Tagesübersicht](docs/screenshots/02-dashboard.png)<br>**Heute:** offene Aufgaben aus Rechnungen und Instanzen | ![Organisationen](docs/screenshots/03-companies.png)<br>**Organisationen** mit Status |
| ![Organisation](docs/screenshots/04-company-detail.png)<br>**Organisation:** Kontakt, Verlauf, nächste Schritte | ![Instanzen](docs/screenshots/05-instances.png)<br>**Instanzen** je Organisation |
| ![Rechnungen](docs/screenshots/06-invoices.png)<br>**Rechnungen** | ![Rechnung](docs/screenshots/07-invoice-detail.png)<br>**Rechnung** mit PDF/XML, Zahlung, Erinnerung |
| ![Anmeldung](docs/screenshots/01-login.png)<br>**Anmeldung** mit Passkey oder Passwort + zweitem Faktor | ![Portal](docs/screenshots/09-portal.png)<br>**Portal** (Modus „Portal“): Liste der Verwaltungen |

## Architektur in Kürze

```
 Betreiber ──► Verwaltung (je Software)        ┌──────────────┐
               control-web (nginx + UI)        │ Coolify-API  │
               control-api (NestJS) ──Provisioner──►            │──► Instanz Kunde A
               control-db  (Postgres)          └──────────────┘──► Instanz Kunde B
                    ▲   │
        Manifest ───┘   └── ruft je Instanz: Health, Setup-Status, Kennzahlen
   (saas-instant.manifest.yaml)              (Instanz-Vertrag)

 Modus portal: zusätzlich ein statisches Portal (Liste + Links) vor mehreren Verwaltungen.
```

- **Eine Verwaltung je Software.** Jede Software bekommt ihre eigene Verwaltung mit eigener Datenbank und eigener Anmeldung.
- **Modus bei der Erstinstallation, danach unveränderlich:** `single` (genau eine Verwaltung) oder `portal` (mehrere Verwaltungen plus ein schlankes Portal, das nur Liste und Links zeigt: keine Kundendaten, keine Anmeldung).
- **Provisioner-Schnittstelle:** drei Operationen (anlegen, Auskunft, stoppen), in v1 nur Coolify.
- **Regel R1, nie löschen:** Die Verwaltung kennt genau eine Datenbank (ihre eigene) und hat keinen Codepfad, der ein Deployment oder eine Datenbank löscht. Archivieren stoppt die Instanz, das Datenvolumen bleibt.
- **Manifest:** `saas-instant.manifest.example.yaml` beschreibt die Software (Name, Mail, Abrechnung, Provisionierung, UI).
- **Instanz-Vertrag:** was eine Software erfüllen muss (drei Umgebungsvariablen, ein Pflicht-Endpunkt, zwei optionale).

Details: [docs/architecture.md](docs/architecture.md), [docs/manifest.md](docs/manifest.md), [docs/instance-contract.md](docs/instance-contract.md).

## Voraussetzungen

- Docker mit Compose v2 (`docker compose`), laufender Docker-Dienst
- `openssl` und `bash` (für `install.sh`)
- für die Instanzverwaltung: eine Coolify-Installation mit API-Token, Projekt, Server und Deploy-Key sowie ein Git-Repository mit der Compose-Definition Ihrer Software, die den Instanz-Vertrag erfüllt
- ein SMTP-Zugang (ohne ihn kommen keine Anmeldecodes und keine Instanz-Einladungen an)
- für Betrieb im Netz: ein TLS-terminierender Reverse-Proxy (z. B. Traefik, Caddy, nginx)

Zum Entwickeln zusätzlich Node 22 und pnpm 11 (siehe `package.json`, `apps/control/Dockerfile`).

## Schnellstart

```bash
git clone <dieses Repository> saas-instant && cd saas-instant
```

**Modus `single`** (eine Verwaltung, kein Portal):

```bash
./install.sh --mode single --software mein-produkt
```

**Modus `portal`** (mehrere Verwaltungen plus Portal):

```bash
./install.sh --mode portal --software produkt-a
bin/saas-instant add produkt-b        # weitere Verwaltung, nur im Modus portal
```

`install.sh` legt je Verwaltung `installations/<slug>/` an (`.env` mit zufälligen Geheimnissen, Rechte 600, plus Kopie des Beispielmanifests), schreibt den Modus in `.saas-instant-mode` fest und startet die Container mit `docker compose`. Die Oberfläche steht danach unter `http://localhost:8080` (weitere Verwaltungen erhalten den nächsten freien Port, das Portal beginnt bei 8090).

Das erste Konto wird im Container angelegt, es entsteht ein Registrierlink für einen Passkey:

```bash
bin/saas-instant emergency mein-produkt first-account admin@example.com "Vorname Nachname"
```

Danach das Manifest `installations/<slug>/saas-instant.manifest.yaml` anpassen und die Verwaltung neu starten (das Manifest wird nur beim Start gelesen). Mit `--dry-run` zeigt `install.sh`, was geschähe, ohne etwas zu schreiben; mit `--no-start` legt es alles an, ohne Container zu starten.

Schritt für Schritt, mit TLS und Proxy-Hinweisen: [docs/installation.md](docs/installation.md).

## Einschränkungen in v1

- **Nur Coolify** als Provisioner. Die Schnittstelle ist vorbereitet, ein zweiter Anbieter existiert nicht.
- **Die Coolify-Anbindung ist nur gegen eine Attrappe getestet**, nicht gegen eine echte Coolify-Installation. Pfade und Abläufe sind aus einem funktionierenden Provisionierungsskript übernommen (`reference/provision-tenant.py`), aber nicht belegt. Rechnen Sie bei der ersten echten Inbetriebnahme mit Nacharbeit.
- **Backend-Meldungen und Mailtexte sind nur deutsch.** Die Oberfläche ist über eine i18n-Schicht übersetzbar ([docs/i18n.md](docs/i18n.md)), liegt aber nur auf Deutsch vor.
- **PDF-Rechnungen brauchen den Rechnungsdienst** (`invoice-renderer`, im Compose-Stapel, Quelle `tools/invoice-renderer`; Adresse `RECHNUNGSDIENST_URL`). Läuft er nicht oder ist die Variable leer gesetzt, bleiben Rechnungen als Datensatz und XML bestehen, ein PDF lässt sich nicht erzeugen.
- **Der Modus (`single`/`portal`) ist nach der Erstinstallation nicht änderbar.** Ein anderer Modus erfordert eine neue Installation in einem leeren Verzeichnis.
- **Portal-Adressen** werden von `install.sh` als `http://<host>:<port>` geschrieben. Für Verwaltungen hinter TLS müssen Sie `portal/registry.json` selbst anpassen; ein erneuter `install.sh`- oder `add`-Lauf schreibt die Datei neu.
- Die Rechnungslogik (Steuersatz, Preisstufen, Leistungsangaben) ist auf deutsche Verhältnisse zugeschnitten; prüfen Sie Ausgabe und Pflichtangaben selbst.

## Dokumentation

| Datei | Inhalt |
|---|---|
| [docs/installation.md](docs/installation.md) | Installation, Konfiguration, TLS und Proxy |
| [docs/manifest.md](docs/manifest.md) | alle Felder des Software-Manifests |
| [docs/architecture.md](docs/architecture.md) | Aufbau, Provisioner, Regel R1, Modi |
| [docs/instance-contract.md](docs/instance-contract.md) | was eine Software erfüllen muss |
| [docs/i18n.md](docs/i18n.md) | Oberflächentexte |
| [docs/rename-glossary.md](docs/rename-glossary.md) | Benennungsregeln (deutsch zu englisch) |
| [docs/operations/backup-and-recovery.md](docs/operations/backup-and-recovery.md) | Sicherung, Meldeweg, Wiederherstellung |
| [docs/operations/emergency-access.md](docs/operations/emergency-access.md) | Notfallzugang (Kommandos im Container) |
| [docs/operations/coolify-setup.md](docs/operations/coolify-setup.md) | Coolify einrichten, bekannte Fallen |
| [docs/operations/billing.md](docs/operations/billing.md) | Rechnungen, SEPA-Mandat, Mailabsender |
| [docs/operations/security-model.md](docs/operations/security-model.md) | Regeln R1 bis R6, Anmeldung, Geheimnisse, Verschlüsselung |

Mitmachen: [CONTRIBUTING.md](CONTRIBUTING.md). Sicherheitslücken melden: [SECURITY.md](SECURITY.md). Herkunft und Drittlizenzen: [NOTICE](NOTICE).

## Lizenz

GNU Affero General Public License v3.0, siehe [LICENSE](LICENSE). Wer eine veränderte Version über ein Netzwerk anbietet, muss den Quelltext dieser Version bereitstellen.
