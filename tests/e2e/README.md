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

- Ergebnisse: `${E2E_OUT}/<suite>/result.json` und Logs der Control-API dort (Standard: Scratchpad `.../e2e-out`).
- Je Schritt eine Zeile `PASS`/`FAIL`; Exit-Code 1, wenn ein Schritt scheitert.
- `E2E_SKIP_BUILD=1` überspringt `nest build`, wenn `dist/` schon aktuell ist.

## Aufräumen

`run.sh` räumt am Ende immer auf (auch bei Abbruch): Docker-Container, Netzwerke und Volumes mit Label `e2e=true`, gestartete Control-Prozesse und alle Datenbanken `e2e_*` auf `si-test-db`. Es werden nie Ressourcen ohne dieses Label angefasst (Regel R1).

## Aufbau

- `lib/control.mjs` — `startControl({port, dbName, env})`, `stopControl`, `login()` (liefert `api(method, path, body)` mit Cookies/CSRF und `proof()` für Routen mit Zweitfaktor-Nachweis; Seed-Benutzer `test`).
- `lib/docker.mjs` — `run`, `composeUp`/`composeDown` (Projektname), `waitHealthy`, `logs`, `cleanup`.
- `lib/util.mjs` — `createSuite().step(name, fn)`, Timeouts, `waitFor`, Ergebnis-JSON.
- `suites/<name>.mjs` — eine Datei je Suite; neue Docker-Ressourcen immer mit `--label e2e=true` anlegen.
