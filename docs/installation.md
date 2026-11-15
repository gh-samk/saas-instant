# Installation

Schritt für Schritt von einem leeren Server bis zur laufenden Verwaltung. Jede Aussage hier ist an `install.sh`, `bin/saas-instant`, `docker-compose.yml` und dem Code von `apps/control` geprüft. Wo etwas nicht stimmig ist, steht es in „Bekannte Unstimmigkeiten“ am Ende.

## 1. Voraussetzungen

| Was | Wofür |
|---|---|
| Docker, Compose v2, laufender Docker-Dienst | `install.sh` bricht ohne ab (außer mit `--dry-run` oder `--no-start`) |
| `openssl`, `bash` | Erzeugen der Geheimnisse (`openssl rand -hex`) |
| TLS-Reverse-Proxy | Betrieb im Netz (Abschnitt 5) |
| SMTP-Zugang | Anmeldecodes, Rechnungs- und Instanz-Mails |
| Coolify mit API-Token, Projekt, Server, Deploy-Key | nur für die Instanzverwaltung (Abschnitt 7) |
| Git-Repository mit der Compose-Definition Ihrer Software | nur für die Instanzverwaltung; es muss den [Instanz-Vertrag](instance-contract.md) erfüllen |

Die Images bauen sich beim ersten Start aus dem Quelltext (`docker compose up -d --build`), das dauert einige Minuten. Beide Dockerfiles nutzen Node 22.

## 2. Modus wählen

Der Modus wird bei der Erstinstallation gewählt und in `.saas-instant-mode` festgeschrieben (Datei mit Rechten 444, Inhalt `mode=<modus>`). Danach lehnt `install.sh` einen anderen Modus ab. Wer wechseln will, installiert neu in einem leeren Verzeichnis.

| Modus | Bedeutung |
|---|---|
| `single` | Genau eine Verwaltung, kein Portal. Eine zweite Verwaltung lehnt `install.sh` ab. |
| `portal` | Mehrere Verwaltungen (je eigene Datenbank und Anmeldung) und ein schlankes Portal: statische Seite mit Liste und Links, keine Kundendaten, keine Anmeldung. |

## 3. Installieren

```bash
./install.sh --mode single --software mein-produkt
# oder
./install.sh --mode portal --software produkt-a
```

Optionen (aus `./install.sh --help`):

| Option | Wirkung |
|---|---|
| `--mode single\|portal` | Betriebsart, nur bei der Erstinstallation wählbar |
| `--software <slug>` | Kennung: a-z, 0-9, Bindestrich, 1 bis 40 Zeichen |
| `--dir <pfad>` | Zielverzeichnis (Vorgabe: der Ordner von `install.sh`) |
| `--host <name>` | Hostname für die Adressen in der `.env` (Vorgabe `localhost`) |
| `--non-interactive` | keine Rückfragen; `--mode` und `--software` sind dann Pflicht |
| `--dry-run` | zeigt, was geschähe; schreibt nichts, auch keinen Modus-Lock, und startet nichts |
| `--no-start` | legt alles an (auch den Modus-Lock), startet aber nichts und braucht kein Docker |
| `--yes` | Bestätigungen mit Ja beantworten |

Was `install.sh` anlegt:

- `.saas-instant-mode` (nur beim ersten Lauf)
- `installations/<slug>/.env`, Rechte 600: Compose-Projektname, Port (ab 8080, der nächste freie), `CONTROL_APP_URL`, `CONTROL_RP_ID`, zufällige Werte für `CONTROL_POSTGRES_PASSWORD`, `JWT_SECRET`, `CONTROL_CONFIG_KEY`, und `MANIFEST_FILE`. Steht im Manifest unter `provisioning.instanceDomainBase` eine echte Domain (nicht der Platzhalter `example.com`), trägt `install.sh` sie als `CONTROL_INSTANCE_BASE_DOMAIN` ein (Verweise der Oberfläche auf Instanzen, siehe [manifest.md](manifest.md)). Existiert die `.env` schon, bleiben ihre Werte unverändert.
- `installations/<slug>/saas-instant.manifest.yaml`: Kopie von `saas-instant.manifest.example.yaml`, mit Ihrer Kennung als `product.slug` (nur falls sie dort noch `mein-produkt` heißt)
- im Modus `portal` zusätzlich `portal/portal.env` (Port ab 8090) und `portal/registry.json` (Liste der Verwaltungen)

Danach startet `docker compose` je Verwaltung die Dienste `control-db` (Postgres 16), `control-api` und `control-web`; im Modus `portal` zusätzlich das Portal. Beim Start der API laufen die Datenbankmigrationen (`prisma migrate deploy`).

**Wichtig:** Die `.env` enthält Geheimnisse. Nicht einchecken, nicht kopieren, sichern. `CONTROL_CONFIG_KEY` verschlüsselt Werte in der Datenbank (z. B. TOTP-Geheimnisse, Instanz-Tokens); geht er verloren oder wird er getauscht, sind diese Werte unlesbar.

### Weitere Verwaltung (nur Modus portal)

```bash
bin/saas-instant add produkt-b
```

### Weitere Befehle

```
bin/saas-instant list                 Verwaltungen und Adressen
bin/saas-instant status [slug]        Containerstatus
bin/saas-instant up [slug]            starten (ohne slug: alle, im Modus portal samt Portal)
bin/saas-instant down [slug]          stoppen, Daten bleiben erhalten
bin/saas-instant emergency <slug> …   Notfallkommandos im Container
```

## 4. Erstes Konto und Manifest

Die Verwaltung startet ohne Konto. Das erste Konto legen Sie im Container an; nur solange es kein einziges Konto gibt:

```bash
bin/saas-instant emergency mein-produkt first-account admin@example.com "Vorname Nachname"
```

Das Kommando gibt einen Registrierlink aus (15 Minuten gültig, das Konto bekommt die Rolle `owner`). Im Browser öffnen und dort einen Passkey anlegen. Weitere Notfallkommandos:

| Kommando | Wirkung |
|---|---|
| `emergency <slug> enrollment <kennung>` | Link zum Anlegen eines Passkeys (15 Minuten) |
| `emergency <slug> password <kennung>` | Link zum Setzen eines neuen Passworts (15 Minuten) |
| `emergency <slug> unlock <kennung>` | Kontosperre und Fehlversuche zurücksetzen |

`<kennung>` ist Benutzername oder E-Mail-Adresse. Es gibt kein „Passwort vergessen“ per E-Mail.

Dann das Manifest anpassen: `installations/<slug>/saas-instant.manifest.yaml`, Felder siehe [manifest.md](manifest.md). Das Manifest wird **nur beim Start** gelesen. Ein ungültiges Manifest verhindert den Start (mit allen Fehlern in der Log-Ausgabe); eine fehlende Datei führt zu neutralen Vorgaben und einer Warnung. Nach Änderungen:

```bash
bin/saas-instant down mein-produkt && bin/saas-instant up mein-produkt
```

## 5. TLS und Betrieb hinter einem Proxy

`install.sh` richtet die Verwaltung für den lokalen Test über `http` ein (`COOKIE_SECURE=0`, `CONTROL_TRUST_PROXY=1`). Für den Betrieb im Netz stellen Sie einen TLS-Proxy vor `control-web` (veröffentlichter Port, Vorgabe 8080, standardmäßig nur an `127.0.0.1` gebunden; `CONTROL_WEB_BIND` ändert das, dann muss der Port durch eine Firewall außerhalb von Docker geschützt sein, weil `X-Forwarded-For` sonst frei wählbar ist) und passen in `installations/<slug>/.env` an:

```bash
CONTROL_APP_URL=https://verwaltung.example.com
CONTROL_RP_ID=verwaltung.example.com
COOKIE_SECURE=1
CONTROL_TRUST_PROXY=2
```

Der TLS-Proxy muss `X-Forwarded-For` selbst setzen (anhängen oder überschreiben) und auf demselben Host laufen oder `CONTROL_WEB_BIND` auf seine Adresse stehen.

Zum Betrieb gehört:

- `JWT_SECRET` wird beim Start geprüft: mindestens 32 Zeichen und kein Beispielwert, sonst startet die Verwaltung nicht. `install.sh` erzeugt einen passenden Wert.
- „Abmelden“ beendet alle Sitzungen des Kontos, nicht nur die des aktuellen Geräts.
- Eine Sitzung endet spätestens 90 Tage nach der Anmeldung, auch wenn sie laufend erneuert wird.
- Ein TOTP-Code ist nur einmal verwendbar; derselbe Code wird innerhalb seines Zeitfensters nicht ein zweites Mal angenommen.
- Der Docker-Port von `control-web` ist standardmäßig an `127.0.0.1` gebunden (`CONTROL_WEB_BIND`, Vorgabe `127.0.0.1`).

Danach `bin/saas-instant up <slug>` (Compose erzeugt den Container mit den neuen Werten neu).

| Variable | Bedeutung und Folge bei falschem Wert |
|---|---|
| `COOKIE_SECURE` | `1` setzt das `Secure`-Flag der Cookies; sie gelten dann nur über HTTPS. Vorgabe im Code und im Compose ist `1`. Hinter TLS **muss** `1` stehen. Bleibt `0` hinter TLS, sind die Sitzungs-Cookies nicht auf HTTPS beschränkt. Steht `1` bei reinem `http`, schlägt die Anmeldung fehl, weil der Browser die Cookies nicht annimmt. |
| `CONTROL_APP_URL` | Öffentliche Adresse der Oberfläche mit Schema (und Port, falls nicht Standard). Sie ist der einzige erlaubte CORS-Ursprung, der von WebAuthn erwartete Origin und die Basis der Notfall-Links. Stimmt sie nicht mit der Adresse im Browser überein, scheitern API-Aufrufe und Passkeys. |
| `CONTROL_RP_ID` | Relying-Party-ID für Passkeys: die **nackte Domain** ohne Schema und ohne Port, passend zu `CONTROL_APP_URL`. Passkeys sind an diese ID gebunden. **Wird sie später geändert, funktionieren bereits registrierte Passkeys nicht mehr.** Daher vor dem ersten Passkey richtig setzen. |
| `CONTROL_RP_NAME` | Name im Passkey-Dialog des Browsers. |
| `CONTROL_TOTP_ISSUER` | Name in der Authenticator-App. |
| `CONTROL_TRUST_PROXY` | Anzahl der Proxys vor der API, denen `X-Forwarded-For` geglaubt wird: `1` = nur das mitgelieferte nginx in `control-web`, `2` = zusätzlich ein TLS-Proxy davor. Bestimmt die IP im Audit-Log und im Rate-Limit. Zu hoch ist gefährlich (ein selbst gesetzter `X-Forwarded-For` wird geglaubt, das Rate-Limit lässt sich umgehen), zu niedrig zeigt nur die Proxy-Adresse. Ein leerer Wert gilt als 0, ein ungültiger bricht den Start ab. |
| `CONTROL_INQUIRY_TRUST_PROXY` | Dasselbe für den öffentlichen Anfrageweg (`/api/public`, `/api/consent/subscription`), dessen Kette länger ist, weil das Formular über das nginx der Webseite kommt. Die Zahl nennt, wie viele Einträge von rechts in `X-Forwarded-For` bis zum Besucher zu überspringen sind. Sie ist der Rückfall; Vorrang hat die Kopfzeile `x-sender-ip`, die das nginx der Webseite selbst schreibt. Sie greift nur mit gültigem `CONTROL_INQUIRY_KEY`. Vorgabe im mitgelieferten `docker-compose.yml`: `2` (Webseiten-nginx, `control-web`, keine weiteren Proxys). Steht davor ein TLS-Proxy, ist es `3`. Die Coolify-Referenz `reference/docker-compose.control.coolify.yml` hat zwei Traefik in der Kette (Traefik, Webseiten-nginx, Traefik, `control-web`) und steht deshalb auf `4`. Zu hoch macht die Herkunft im Nachweis und das Rate-Limit fälschbar, zu niedrig lässt alle Besucher ein Kontingent teilen. Ein ungültiger Wert (keine ganze Zahl >= 1) bricht den Start ab. |

Hinweise zum Proxy:

- Er muss `Host` und `X-Forwarded-For` unverändert bzw. anhängend weiterreichen.
- `docker-compose.yml` veröffentlicht `control-web` als `${CONTROL_WEB_PORT}:80` auf **allen** Schnittstellen. Läuft der Proxy auf demselben Host, sperren Sie den Port per Firewall nach außen oder binden Sie ihn selbst an `127.0.0.1`; sonst ist die Verwaltung auch ohne TLS erreichbar.
- Das mitgelieferte nginx (`control-web`) proxyt `/api/` an `control-api:3001` und maskiert Token-Pfade im Zugriffslog. Ein eigener Proxy davor sollte Token-Pfade (`/api/intake/…`, `/api/consent/…`, Notfall-Links) ebenfalls nicht im Klartext protokollieren.
- Im Modus `portal` schreibt `install.sh` die Adressen in `portal/registry.json` als `http://<host>:<port>`. Für Verwaltungen hinter TLS tragen Sie die `https`-Adressen selbst in die Datei ein. Ein erneuter `install.sh`- oder `add`-Lauf schreibt sie neu.
- Der Betrieb mit Coolify für die Verwaltung selbst ist in `reference/docker-compose.control.coolify.yml` skizziert (Traefik terminiert TLS, nur `control-web` bekommt eine Domain). Das ist eine Vorlage, kein getesteter Weg.

## 6. Postausgang

Ohne `SMTP_HOST` verschickt die Verwaltung nichts; Anmeldecodes landen dann nur in der Server-Konsole. Für den Betrieb setzen Sie in der `.env`:

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=587          # 465 = SMTPS, 587/25 = STARTTLS
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=Mein Produkt <noreply@example.com>
```

- `SMTP_FROM` aus der Umgebung hat Vorrang vor `mail.senderName`/`mail.senderAddress` des Manifests. Der Compose gibt `SMTP_FROM` immer weiter (leer, wenn in der `.env` nicht gesetzt), und ein leerer Wert zählt als gesetzt. Setzen Sie `SMTP_FROM` deshalb ausdrücklich.
- Mit `NODE_ENV=production` (Vorgabe im Compose) prüft der Start, dass alle Absenderadressen auf der Maildomäne liegen (`mail.domain`, sonst die Domäne von `mail.senderAddress`); sonst startet die Verwaltung nicht.
- `SMTP_TLS_ERZWINGEN=0` ist in Produktion nicht zulässig.
- Die Mailtexte sind in v1 deutsch.

## 7. Instanzverwaltung mit Coolify

Ohne `CONTROL_COOLIFY_TOKEN` bleibt die Instanzverwaltung sichtbar aus (HTTP 503); alle anderen Bereiche laufen unverändert. Nötig sind:

1. In Coolify ein **eigenes API-Token** für die Verwaltung. Es braucht lesende Rechte auf Anwendungen und Server sowie das Recht, Anwendungen anzulegen, aber **kein Löschrecht**: Die Verwaltung hat keinen Löschpfad (Regel R1), und ein Token, das mehr darf als der Code, ist unnötiges Risiko.
2. Die UUIDs von Projekt, Server und Deploy-Key aus Ihrer Coolify-Installation.
3. Ein Git-Repository mit der Compose-Definition Ihrer Software (Vorlage: `docker-compose.coolify.yml`, die den [Instanz-Vertrag](instance-contract.md) zeigt) und der Deploy-Key mit Lesezugriff darauf.
4. SMTP-Daten, die jede neue Instanz mitbekommt. Ohne Host und Absender wird **keine** Instanz angelegt.
5. Im Manifest den Abschnitt `provisioning` (Basisdomain, Präfix, Pfade, Repository), siehe [manifest.md](manifest.md).

Umgebungsvariablen, die der Code liest (`apps/control/src/coolify/coolify.config.ts`, Rangfolge: Umgebung, dann Manifest, dann Vorgabe):

| Variable | Bedeutung |
|---|---|
| `CONTROL_COOLIFY_TOKEN` | API-Token; ohne ihn ist die Anbindung aus |
| `CONTROL_COOLIFY_API_URL` | Vorgabe `http://localhost:8000/api/v1`; muss mit `http` beginnen |
| `CONTROL_COOLIFY_PROJECT_UUID`, `CONTROL_COOLIFY_SERVER_UUID`, `CONTROL_COOLIFY_DEPLOY_KEY_UUID` | gehören zu Ihrer Coolify-Installation, keine Vorgabe |
| `CONTROL_COOLIFY_REPO`, `CONTROL_COOLIFY_BRANCH`, `CONTROL_COOLIFY_COMPOSE` | Repository, Branch (Vorgabe `main`), Pfad der Compose-Datei (Vorgabe `/docker-compose.coolify.yml`) |
| `CONTROL_COOLIFY_UMGEBUNG` | Coolify-Umgebung (Vorgabe `production`) |
| `CONTROL_COOLIFY_OWN_APPLICATIONS` | kommagetrennte eigene Anwendungen, die der Abgleich nicht als verwaist meldet |
| `CONTROL_INSTANCE_BASE_DOMAIN`, `CONTROL_INSTANCE_PREFIX` | überschreiben `provisioning.instanceDomainBase` und `provisioning.instancePrefix` |
| `CONTROL_INSTANCE_SETUP_PATH`, `CONTROL_INSTANCE_SETUP_STATUS_PATH`, `CONTROL_INSTANCE_METRICS_PATH` | überschreiben die Pfade des Instanz-Vertrags |
| `CONTROL_INSTANCE_SMTP_HOST`, `_PORT`, `_USER`, `_PASS`, `_FROM` | Postausgang der Instanzen; `HOST` und `FROM` sind Pflicht |
| `CONTROL_METRICS_FETCH_ENABLED`, `CONTROL_RECONCILIATION_ENABLED` | `nein` schaltet den nächtlichen Kennzahlenabruf (04:00) bzw. den Abgleich mit Coolify (04:30) ab |
| `CONTROL_BACKUP_KEY` | Schlüssel, mit dem sich ein Sicherungswerkzeug bei `POST /api/backups` ausweist |
| `RECHNUNGSDIENST_URL` | Adresse des Rechnungsdienstes für PDF/A-3. Das Compose startet den Dienst `invoice-renderer` (Quelle `tools/invoice-renderer`, nur im Compose-Netz, ohne Port nach außen) und setzt `http://invoice-renderer:8080`; Vorgabe im Code ohne Compose `http://rechnungsdienst:8080`; ausdrücklich leer = PDF-Erzeugung aus |

**Ehrlicher Stand:** Diese Anbindung ist nur gegen eine Attrappe getestet. Machen Sie die erste Inbetriebnahme mit einer Test-Instanz und beobachten Sie Coolify dabei. Die Verwaltung legt nur an und stoppt; wenn etwas scheitert, steht die Anwendung unter Umständen in Coolify und muss dort von Hand aufgeräumt werden (die Verwaltung löscht sie nie).

## 8. Weitere Betriebsvariablen

Auswahl der im Code gelesenen Variablen, die nicht Teil der Pflichtwerte sind:

| Variable | Bedeutung |
|---|---|
| `APP_TIMEZONE` | Zeitzone des Containers (Vorgabe `Europe/Berlin`); bestimmt, welcher Kalendertag „heute“ ist |
| `CONTROL_SCHEDULE_ENABLED` | `nein` schaltet den täglichen Zeitplan (03:00) ab |
| `CONTROL_INQUIRY_KEY`, `CONTROL_INQUIRY_RECIPIENT` | Schlüssel des öffentlichen Anfrageweges und Empfängeradresse (alternativ `mail.inquiryTo`) |
| `CONTROL_MAIL_BASE_URL` | Basis-URL in Mails, falls abweichend von `CONTROL_APP_URL` |
| `MAIL_DOMAIN`, `MAIL_SENDER_INVOICE`, `MAIL_SENDER_BROADCAST`, `MAIL_REPLY_TO`, `MAIL_RETURN_PATH` | Absender-Feinsteuerung |
| `CONTROL_PRICE_TABLE` | Preistafel als JSON; ist sie gesetzt und fehlerhaft, startet die Anwendung nicht |
| `CONTROL_INVOICE_*` | Ausstellerangaben der Rechnung (überschreiben `billing.issuer`) |

Die vollständige, kommentierte Liste steht in `apps/control/.env.example`. `docker-compose.yml` reicht alle diese Variablen unter ihrem Namen im Code an `control-api` durch: Was in der `.env` steht, kommt im Container an; was fehlt, bleibt dort ungesetzt, und die Vorgabe des Codes (oder des Manifests) gilt. Neue Variablen im Code gehören in den `environment:`-Block von `control-api` (Schreibweise `NAME:` ohne Wert).

## 9. Prüfen

```bash
docker compose --env-file .env.example config -q   # Compose-Datei gegen Beispielwerte prüfen
bin/saas-instant status <slug>
tests/install.test.sh                               # Test von install.sh und bin/saas-instant (ohne Docker, mit --no-start/--dry-run)
```

## Bekannte Unstimmigkeiten

Stand der Prüfung dieser Dokumentation. Das sind Fehler im Repository, keine Absicht.


Zurzeit sind keine offenen Punkte bekannt.
