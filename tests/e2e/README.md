# E2E-Tests

Ende-zu-Ende-Läufe gegen die echte Control-API (aus dem Quellcode) und Docker.

## Voraussetzungen

- Docker (laufend) und der Test-Postgres-Container `si-test-db` auf `127.0.0.1:54329` (Benutzer `postgres`, Passwort `demo`; änderbar über `E2E_DB_CONTAINER`, `E2E_DB_HOST`, `E2E_DB_PORT`, `E2E_DB_USER`, `E2E_DB_PASSWORD`).
- Node >= 20 und pnpm; `pnpm install` im Repo-Wurzelverzeichnis ist erfolgt.
- Netz für Image-Pulls (Suiten `backup`, `invoice`, `install`).

## Ausführen

```sh
tests/e2e/run.sh smoke    # Control startet, Login (Passwort + TOTP), GET /api/public-config
tests/e2e/run.sh backup   # bzw. invoice | install | all
```

- Ergebnisse: `${E2E_OUT}/<suite>/result.json` und Logs der Control-API dort (Standard: `${TMPDIR:-/tmp}/saas-instant-e2e`, änderbar über `E2E_OUT`).
- Je Schritt eine Zeile `PASS`/`FAIL`; Exit-Code 1, wenn ein Schritt scheitert.
- `E2E_PLAYWRIGHT_CORE`: Pfad zu `playwright-core` für die Suite `install` (Standard: Auflösung `playwright-core` aus dem Repo; sonst z. B. `E2E_PLAYWRIGHT_CORE=/pfad/zu/node_modules/playwright-core`).
- `E2E_SKIP_BUILD=1` überspringt `nest build`, wenn `dist/` schon aktuell ist.

## Suite `invoice` (Rechnungen, Firmendaten je Rechtsform)

Echtes Zusammenspiel von Control-API, Rechnungsdienst-Container (gehärtet), Mailpit, veraPDF und KoSIT. Der Aussteller kommt nicht aus dem Manifest, sondern per `PUT /api/settings/issuer` (Einstellungen → Firmendaten).

- **Rechtsform-Matrix** (`invoice/fixtures.mjs`, fiktive Daten): Einzelunternehmen, e.K., GbR, eGbR, OHG, GmbH, UG, GmbH & Co. KG, eG, e.V. Je Form (a) absichtlich unvollständig → Festschreiben scheitert mit `422 issuer_incomplete`, die Feldliste (Feld und Code) entspricht genau der Erwartung, es wird keine Nummer vergeben; (b) vollständig → festgeschrieben, ZUGFeRD-PDF und Factur-X-XML abrufbar; der PDF-Text enthält alle Pflichtzeilen der Form (von Hand aus `docs/operations/invoice-legal-requirements.md` abgeleitet, nicht aus dem Produktcode berechnet), Firmenname und Anschrift stehen genau einmal im PDF, die Pflichtzeilen stehen auch im XML (BT-33). GmbH & Co. KG, GmbH und eG zusätzlich als XRechnung mit KoSIT.
- **Design:** Logo (PNG-Upload, ungültige Uploads → 415, öffentliche Auslieferung, Bild im PDF), ohne Logo kein Bild und der Firmenname; Akzentfarbe `#0B5C8A` in `public-config` und als Farbe im PDF-Inhaltsstrom, `#FFFF00` und `blau` → 422.
- **Hauptrechnungen** nach `${E2E_OUT}/invoice/`: `rechnung-gmbh-co-kg-behoerde.{pdf,factur-x.xml,xrechnung.xml}` (Empfänger Behörde mit Leitweg-ID), `rechnung-gmbh-unternehmen.*` (Empfänger Unternehmenskunde), `vorschau-<name>.png`; Matrix unter `formen/`, Design unter `design/`, PDF-Text unter `pdftext/`. veraPDF (PDF/A-3b) prüft ALLE erzeugten PDFs.
- **PDF-Text:** `invoice/PdfText.java` läuft im Rechnungsdienst-Image (Java-Quelltextmodus, PDFBox aus `mustang-cli.jar`); es werden keine Werkzeuge auf dem Host benötigt.
- **Zweiter Faktor ohne Wartezeit:** Die API verlangt den Nachweis nur bei Anmeldungen, die älter als 10 Minuten sind. Die Suite schickt daher keine TOTP-Codes pro Aufruf, sondern meldet sich nach 7 Minuten neu an (ein Code je Anmeldung). Die Routen sind auf 10 Aufrufe je Minute begrenzt; ein Zähler in der Suite hält 9 je Minute ein. Ein vollständiger Lauf dauert deshalb mehrere Minuten.
- **Ports:** Rechnungsdienst 18080, Mailpit 18025/11025, Control 13002/13003, Datenbanken `e2e_invoice*`; Container tragen `e2e=true` und `e2e.suite=invoice`.

## Aufräumen

`run.sh` räumt am Ende immer auf (auch bei Abbruch): Docker-Container, Netzwerke und Volumes mit Label `e2e=true`, gestartete Control-Prozesse und alle Datenbanken `e2e_*` auf `si-test-db`. Es werden nie Ressourcen ohne dieses Label angefasst (Regel R1).

## Aufbau

- `lib/control.mjs` — `startControl({port, dbName, env})`, `stopControl`, `login()` (liefert `api(method, path, body)` mit Cookies/CSRF und `proof()` für Routen mit Zweitfaktor-Nachweis; Seed-Benutzer `test`).
- `lib/docker.mjs` — `run`, `composeUp`/`composeDown` (Projektname), `waitHealthy`, `logs`, `cleanup`.
- `lib/util.mjs` — `createSuite().step(name, fn)`, Timeouts, `waitFor`, Ergebnis-JSON.
- `suites/<name>.mjs` — eine Datei je Suite; neue Docker-Ressourcen immer mit `--label e2e=true` anlegen.
