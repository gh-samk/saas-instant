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
- **Instanzen:** anlegen über den Provisioner (Vorschau, Fortschritt, Gesundheitsprüfung), Einladungslink für das Erst-Setup, Erreichbarkeitsprüfung, nächtlicher Kennzahlenabruf, nächtlicher Abgleich mit Coolify, Archivieren (Stoppen). **Sicherungen:** Ziel (S3 oder SFTP-Storage-Box) in den Einstellungen, „Jetzt sichern“, Prüfsummenprüfung, Wiederherstellung in eine **neue** Instanz mit anschließender Übernahme (siehe unten und Einschränkungen).
- **Rechnungen:** Preisstufen (Voreinstellung aus dem Manifest, als Preisliste in den Einstellungen änderbar), Entwurf, Festschreiben (danach unveränderlich), Versand per Mail, Mahnung, Zahlungserfassung, Storno, Nummernkreis. **E-Rechnung:** XML nach EN 16931 (CII) entsteht im Backend, das PDF/A-3-Dokument (ZUGFeRD/Factur-X, Profil EN 16931) erzeugt der Dienst `invoice-renderer` (Quelle `tools/invoice-renderer`, läuft im Compose-Stapel); dazu die **XRechnung** als reine XML-Datei.
- **GoBD-Bausteine:** Datenbank-Trigger sperren Änderung und Löschung festgeschriebener Rechnungen und des Audit-Logs; Dokumente werden einmal erzeugt und mit SHA-256 gespeichert; nächtlicher Integritätslauf mit Aufgabe „Beleg manipuliert“; Verlauf je Rechnung; Aufbewahrungsende je Rechnung (Vorgabe 8 Jahre); Export für die Betriebsprüfung. Das ist die **technische Umsetzung**. Verfahrensdokumentation (Vorlage in [docs/operations/gobd.md](docs/operations/gobd.md)) und Rechtsprüfung liegen beim Betreiber und seiner Steuerberatung.
- **Sicherung und Wiederherstellung:** ein eigener **Backup-Agent** (Container im Compose-Stapel) sichert Instanzen, die Verwaltungs-Datenbank und ein Rechnungsarchiv verschlüsselt (age) auf S3 (optional mit Object Lock) oder eine Storage Box. Zugangsdaten liegen nur im Agent und sind in der Oberfläche write-only. Details: [docs/operations/backup-and-recovery.md](docs/operations/backup-and-recovery.md).
- **Mail:** Postausgang mit Warteschlange, getrennt in Transaktionsmails und werbliche Rundmails; Rundmails nur mit Einwilligung (Double-Opt-in, Sperrliste).
- **Aufgabenliste „Heute“:** abgeleitete Hinweise (überfällige Rechnungen, fehlende Sicherung, fehlgeschlagener Kennzahlenabruf, Abweichung zu Coolify usw.).
- **Bedienung:** Kommandopalette mit ⌘K (Strg+K): Organisationen suchen und Aktionen wie „Neue Organisation“ oder „Rechnung anlegen“ starten. Formulare mit Speicherleiste, die vor ungespeicherten Änderungen warnt. Rechnungs- und Erinnerungsversand verlangt eine Bestätigung. Neue Organisationen führt eine Schrittliste („Nächste Schritte“) durch Vertrag, erste Rechnung und Stellvertretung. Auf dem Telefon werden Tabellen zu Kartenansichten.
- **Betriebsschalter:** Feature-Flags, die Instanzen über `GET /api/flags` lesen.
- **Anmeldung:** Passkey oder Passwort mit zweitem Faktor (E-Mail-Code, Authenticator-App oder Passkey), Wiederherstellungscodes, Audit- und Sicherheitslog, Notfallkommandos im Container. Rollen: `owner` und `administrator`.
- **Feldverschlüsselung mit Tresor:** Kundendaten (Organisationen, Notizen, Rechnungsinhalte und -dokumente, Mails, Einwilligungen, Audit-Details) liegen in der Datenbank, in Dumps und Sicherungen nur als Chiffretext (AES-256-GCM). Der Schlüssel liegt nach jedem Neustart gesperrt im Tresor und wird per Passphrase oder Wiederherstellungsschlüssel entsperrt; erst dann laufen Oberfläche und Nachtjobs. Details: [docs/operations/security-model.md](docs/operations/security-model.md).
- **Gemeinsame Anmeldung im Modus `portal`:** Konten, Passkeys und zweite Faktoren liegen zentral im Portal (Anmeldedienst `portal-auth`, OpenID Connect mit PKCE). Nach einer Anmeldung öffnen sich alle Verwaltungen ohne erneute Anmeldung; Rollen `admin` oder `staff` je Verwaltung, frischer zweiter Faktor (Step-up) für sensible Aktionen, Abmelden beendet alle Sitzungen, lokaler Notzugang bleibt. Details: [docs/operations/sso.md](docs/operations/sso.md).

## Screenshots

Aufgenommen mit den frei erfundenen Demo-Daten aus `pnpm --filter @saas-instant/control seed:demo` (siehe [CONTRIBUTING.md](CONTRIBUTING.md)). Das Design ist bewusst neutral (Inter, Slate-Grau, ein ruhiger Blauakzent) und folgt automatisch dem hellen oder dunklen Farbschema des Systems; in der Seitenleiste lässt es sich auch von Hand umschalten.

| | |
|---|---|
| ![Tagesübersicht](docs/screenshots/02-dashboard.png)<br>**Heute:** offene Aufgaben aus Rechnungen und Instanzen | ![Organisationen](docs/screenshots/03-companies.png)<br>**Organisationen** mit Status |
| ![Organisation](docs/screenshots/04-company-detail.png)<br>**Organisation:** Kontakt, Verlauf, Schrittliste „Nächste Schritte“ | ![Instanzen](docs/screenshots/05-instances.png)<br>**Instanzen** mit Version, Personen und letzter Sicherung |
| ![Rechnungen](docs/screenshots/06-invoices.png)<br>**Rechnungen** | ![Rechnung](docs/screenshots/07-invoice-detail.png)<br>**Rechnung** mit Aktionsleiste: Zahlung, Herunterladen, Weitere ⋯ |
| ![Rechnungen, dunkel](docs/screenshots/06-invoices-dark.png)<br>**Dunkelmodus** | ![Anmeldung](docs/screenshots/01-login.png)<br>**Anmeldung** mit Passkey oder Passwort + zweitem Faktor |
| ![Portal](docs/screenshots/09-portal.png)<br>**Portal** (Modus „Portal“): Liste der Verwaltungen | ![Portal, dunkel](docs/screenshots/09-portal-dark.png)<br>**Portal** im Dunkelmodus |
| ![Preise](docs/screenshots/10-settings-prices.png)<br>**Einstellungen → Preise** (linke Navigation): Stufen, Steuersatz, Zahlungsziel | ![Sicherung](docs/screenshots/11-settings-backup.png)<br>**Einstellungen → Sicherung:** S3 oder Storage Box |
| ![Instanz-Sicherungen](docs/screenshots/12-instance-backups.png)<br>**Instanz → Sicherungen** | ![Wiederherstellen](docs/screenshots/12-instance-backups-restore.png)<br>**Als neue Instanz wiederherstellen** |
| ![XRechnung](docs/screenshots/13-invoice-xrechnung.png)<br>**Rechnung an eine Behörde:** Menü „Herunterladen“ mit XRechnung, ZUGFeRD, Integrität | ![GoBD-Export](docs/screenshots/14-gobd-export.png)<br>**Export für die Betriebsprüfung** |
| ![Portal-Anmeldung](docs/screenshots/20-portal-login.png)<br>**Portal-Anmeldung** (Modus „Portal“) | ![Verwaltungen](docs/screenshots/21-portal-launcher.png)<br>**Portal:** Verwaltungen nach der Anmeldung |
| ![Konten und Zugriffe](docs/screenshots/22-portal-accounts.png)<br>**Konten und Zugriffe:** Rolle je Verwaltung | ![Verwaltung im Portal-Modus](docs/screenshots/23-control-portal-login.png)<br>**Verwaltung** leitet zur Portal-Anmeldung |
| ![Kein Zugriff](docs/screenshots/24-control-no-access.png)<br>**Kein Zugriff** ohne Rolle für diese Verwaltung | ![Step-up](docs/screenshots/25-step-up.png)<br>**Step-up:** frischer zweiter Faktor im Portal |
| ![Tresor einrichten](docs/screenshots/26-vault-setup.png)<br>**Tresor einrichten** mit Wiederherstellungsschlüssel | ![Entsperren](docs/screenshots/27-vault-unlock.png)<br>**Verwaltung entsperren** nach dem Neustart |
| ![Sicherheit](docs/screenshots/28-settings-security-vault.png)<br>**Einstellungen → Sicherheit:** Passphrasen und Protokoll | ![Portal-Anmeldung, dunkel](docs/screenshots/20-portal-login-dark.png)<br>**Portal-Anmeldung** im Dunkelmodus |
| ![Kommandopalette](docs/screenshots/29-command-palette.png)<br>**Kommandopalette** (⌘K): Suche nach „Stein“, Aktionen bei leerer Eingabe | ![Heute auf dem Telefon](docs/screenshots/30-mobile-today.png)<br>**Heute** auf dem Telefon (375 px) |

## Architektur in Kürze

```
 Betreiber ──► Verwaltung (je Software)        ┌──────────────┐
               control-web (nginx + UI)        │ Coolify-API  │
               control-api (NestJS) ──Provisioner──►            │──► Instanz Kunde A
               control-db  (Postgres)          └──────────────┘──► Instanz Kunde B
                    ▲   │
        Manifest ───┘   └── ruft je Instanz: Health, Setup-Status, Kennzahlen
   (saas-instant.manifest.yaml)              (Instanz-Vertrag)

 Modus portal: zusätzlich ein Portal mit gemeinsamer Anmeldung (Anmeldedienst `portal-auth`, OIDC) vor mehreren Verwaltungen.
```

Der Backup-Agent (`backup-agent`) und der `docker-socket-proxy` laufen im selben Compose-Stapel, ohne veröffentlichten Port; Details in [docs/architecture.md](docs/architecture.md).

- **Eine Verwaltung je Software.** Jede Software bekommt ihre eigene Verwaltung mit eigener Datenbank und eigener Anmeldung.
- **Modus bei der Erstinstallation, danach unveränderlich:** `single` (genau eine Verwaltung) oder `portal` (mehrere Verwaltungen plus ein Portal: Liste der Verwaltungen und gemeinsame Anmeldung über den Anmeldedienst `portal-auth`, keine Kundendaten im Portal).
- **Provisioner-Schnittstelle:** drei Operationen (anlegen, Auskunft, stoppen), in v1 nur Coolify.
- **Regel R1, nie löschen:** Die Verwaltung kennt genau eine Datenbank (ihre eigene) und hat keinen Codepfad, der ein Deployment oder eine Datenbank löscht. Archivieren stoppt die Instanz, das Datenvolumen bleibt. Eine Wiederherstellung entsteht immer als **neue** Instanz; bei der Übernahme wird die alte gestoppt, nie gelöscht.
- **Backup-Agent:** führt Sicherung und Wiederherstellung aus (die Verwaltung löst sie nur aus), HMAC-signierte Aufträge im internen Netz, Docker-Zugriff nur über einen `docker-socket-proxy` mit Allowlist.
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

Im Modus `portal` meldet jede Verwaltung über das Portal an: `install.sh` erzeugt die Geheimnisse (`portal/portal.env`, je Verwaltung ein eigenes Client-Secret), startet den Anmeldedienst, registriert die Verwaltung dort und legt beim ersten Mal das erste Portal-Konto an (Einmal-Link am Ende der Ausgabe; `--admin-email`, `--admin-name`). Hinter TLS: `--portal-url https://portal.example.com` und `--app-url https://verwaltung.example.com`. Rollen: `bin/saas-instant portal set-role <email> <slug> admin|staff`. Lokale Anmeldung gibt es dann nur noch als Notzugang (`bin/saas-instant emergency <slug> …`). Ablauf, Rollen, Step-up, Ausfall und Schlüsselwechsel: [docs/operations/sso.md](docs/operations/sso.md).

`install.sh` legt je Verwaltung `installations/<slug>/` an (`.env` mit zufälligen Geheimnissen, Rechte 600, plus Kopie des Beispielmanifests), schreibt den Modus in `.saas-instant-mode` fest und startet die Container mit `docker compose`. Die Oberfläche steht danach unter `http://localhost:8080` (weitere Verwaltungen erhalten den nächsten freien Port, das Portal beginnt bei 8090).

Das erste Konto wird im Container angelegt, es entsteht ein Registrierlink für einen Passkey:

```bash
bin/saas-instant emergency mein-produkt first-account admin@example.com "Vorname Nachname"
```

Danach das Manifest `installations/<slug>/saas-instant.manifest.yaml` anpassen und die Verwaltung neu starten (das Manifest wird nur beim Start gelesen). Mit `--dry-run` zeigt `install.sh`, was geschähe, ohne etwas zu schreiben; mit `--no-start` legt es alles an, ohne Container zu starten.

Schritt für Schritt, mit TLS und Proxy-Hinweisen: [docs/installation.md](docs/installation.md).

## Einschränkungen in v1

- **Teststand:** Unit-, Integrations- (echtes Postgres) und Oberflächentests sind grün (Verwaltung: 1617 Jest-, 859 Vitest-, 575 Integrationstests; Backup-Agent 57, Rechnungsdienst 26, Anmeldedienst 10 Unit- und 45 Integrationstests, gemeinsames Anmeldepaket 31, geteilte Oberflächenbausteine 47, geteiltes Typpaket 71). Die Kontrastprüfung (`pnpm contrast`) besteht mit 150 Farbpaaren in Hell und Dunkel. Zusätzlich laufen fünf Ende-zu-Ende-Suiten mit echten Containern (`bash tests/e2e/run.sh <backup|invoice|install|vault|sso>`, [tests/e2e/README.md](tests/e2e/README.md)): **Sicherung/Wiederherstellung** (MinIO mit Object Lock, SFTP als Storage-Box-Ersatz, Mock-Coolify; 21 Schritte), **Rechnung** (Rechnungsdienst, alle Rechtsformen mit Pflichtangaben-Prüfung, ZUGFeRD-PDF/A-3b mit veraPDF geprüft, XRechnung und Factur-X mit dem KoSIT-Validator als akzeptabel bewertet, GoBD-Export mit `sha256sum -c`, Mails über Mailpit; 40 Schritte) und **Installation** (`single`, `portal` mit zweiter Verwaltung, Bindung/Slug-Abweichung, Betrieb hinter TLS mit Caddy; 34 Schritte), **Tresor** (nur Chiffretext in Tabellen und Dump, Sperre nach Neustart, falsche Passphrase, Wiederherstellungsschlüssel, Suche und GoBD-Prüfung; 21 Schritte) und **SSO** (Portal mit zwei Verwaltungen, Rollen, Step-up, gemeinsames Abmelden, Notzugang bei gestopptem Portal, manipulierte Token; 11 Schritte). Ein Beispiel der erzeugten Rechnung (fiktive Daten): [PDF](docs/examples/rechnung-zugferd-beispiel.pdf), [XRechnung-XML](docs/examples/rechnung-xrechnung-beispiel.xml). **Nicht geprüft:** Mailversand gegen einen echten Anbieter, Betrieb mit einem echten Coolify und mit einem Produktivspeicher, Prüfung der Rechnungen durch eine Behörde oder ein Steuerberatungssystem.
- **Der Backup-Agent ist nur gegen eine kleine Compose-Attrappe und Ersatz-Gegenstellen getestet**, nicht gegen eine echte Coolify-Installation und nicht gegen einen Produktivspeicher. Die Prüfung in der Verwaltung ist eine Prüfsumme der verschlüsselten Datei; ob sich eine Sicherung entschlüsseln und einspielen lässt, zeigt nur eine Rückspielprobe mit Ihrem privaten Schlüssel (wird nur einmal angezeigt und nirgends gespeichert). Der Docker-Zugriff des Agents bleibt ein Restrisiko ([docs/operations/security-model.md](docs/operations/security-model.md)).
- **Tresor: Wer alle Passphrasen und den Wiederherstellungsschlüssel verliert, verliert die Kundendaten**, auch in den Sicherungen. Die Verschlüsselung schützt Datenbank, Dumps und Sicherungen, nicht aber einen entsperrten, laufenden Server gegen Root-Zugriff; Mails und der Rechnungsdienst erhalten Klartext. Mitarbeiterkonten und Einträge vor dem ersten Entsperren bleiben unverschlüsselt. Suche und Sortierung laufen im Speicher und sind für Hunderte bis wenige Tausend Organisationen ausgelegt.
- **Gemeinsame Anmeldung (Modus `portal`):** Das Portal wird zum zentralen Anmeldepunkt; fällt es aus, bleibt je Verwaltung nur der Notzugang. Nicht geprüft: Passkey in einem echten Browser mit echtem Authenticator, Betrieb des Anmeldedienstes hinter TLS. Admin-Aktionen im Portal selbst verlangen keinen Step-up, die Anmeldebremse zählt nur im Prozessspeicher, neue Konten erhalten keine Einladungsmail (Einmal-Link von Hand weitergeben).
- **GoBD ist keine Rechtsberatung.** Die Software liefert technische Bausteine; ob Ihr Gesamtverfahren konform ist, entscheiden Sie mit Ihrer Steuerberatung. Die Trigger schützen nicht vor einem Superuser auf dem Datenbankserver; die Datenbankrolle der Anwendung sollte kein `TRUNCATE` besitzen (Betreiberaufgabe, [docs/operations/gobd.md](docs/operations/gobd.md)). Die E-Rechnungsformate prüft die Ende-zu-Ende-Suite mit KoSIT und veraPDF (Stand der Validator-Konfiguration: XRechnung 3.0.2); das ersetzt keine Prüfung durch die empfangende Stelle. UBL als XRechnung-Syntax gibt es in v1 nicht (nur CII).
- **Nur Coolify** als Provisioner. Die Schnittstelle ist vorbereitet, ein zweiter Anbieter existiert nicht.
- **Die Coolify-Anbindung ist nur gegen eine Attrappe getestet**, nicht gegen eine echte Coolify-Installation. Pfade und Abläufe sind aus einem funktionierenden Provisionierungsskript übernommen (`reference/provision-tenant.py`), aber nicht belegt. Rechnen Sie bei der ersten echten Inbetriebnahme mit Nacharbeit.
- **Backend-Meldungen und Mailtexte sind nur deutsch.** Die Oberfläche ist über eine i18n-Schicht übersetzbar ([docs/i18n.md](docs/i18n.md)), liegt aber nur auf Deutsch vor.
- **PDF-Rechnungen brauchen den Rechnungsdienst** (`invoice-renderer`, im Compose-Stapel, Quelle `tools/invoice-renderer`; Adresse `RECHNUNGSDIENST_URL`). Läuft er nicht oder ist die Variable leer gesetzt, bleiben Rechnungen als Datensatz und XML bestehen, ein PDF lässt sich nicht erzeugen.
- **Der Modus (`single`/`portal`) ist nach der Erstinstallation nicht änderbar.** Ein anderer Modus erfordert eine neue Installation in einem leeren Verzeichnis.
- **Portal-Adressen** schreibt `install.sh` aus `CONTROL_APP_URL` der Verwaltung in `portal/registry/registry.json` (ohne `--app-url`: `http://<host>:<port>`). Für Verwaltungen hinter TLS beim Anlegen `--app-url https://…` angeben; ein erneuter `install.sh`- oder `add`-Lauf schreibt die Registry neu.
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
| [docs/operations/backup-and-recovery.md](docs/operations/backup-and-recovery.md) | Backup-Agent, Einrichtung, Wiederherstellung und Übernahme |
| [docs/operations/gobd.md](docs/operations/gobd.md) | GoBD: technische Umsetzung, Vorlage für die Verfahrensdokumentation |
| [docs/operations/emergency-access.md](docs/operations/emergency-access.md) | Notfallzugang (Kommandos im Container) |
| [docs/operations/coolify-setup.md](docs/operations/coolify-setup.md) | Coolify einrichten, bekannte Fallen |
| [docs/operations/billing.md](docs/operations/billing.md) | Rechnungen, SEPA-Mandat, Mailabsender |
| [docs/operations/security-model.md](docs/operations/security-model.md) | Regeln R1 bis R6, Anmeldung, Geheimnisse, Verschlüsselung, Tresor |
| [docs/operations/sso.md](docs/operations/sso.md) | Gemeinsame Anmeldung im Modus `portal`: Ablauf, Rollen, Step-up, Ausfall |

Mitmachen: [CONTRIBUTING.md](CONTRIBUTING.md). Sicherheitslücken melden: [SECURITY.md](SECURITY.md). Herkunft und Drittlizenzen: [NOTICE](NOTICE).

## Lizenz

GNU Affero General Public License v3.0, siehe [LICENSE](LICENSE). Wer eine veränderte Version über ein Netzwerk anbietet, muss den Quelltext dieser Version bereitstellen.
