# Mitmachen

Danke für dein Interesse an saas-instant. Dieses Dokument beschreibt, wie du die
Entwicklungsumgebung einrichtest, die Tests laufen lässt und welche Konventionen
gelten.

*English summary: Node 22 and pnpm 11, `pnpm install`, `pnpm test`. Identifiers in
code are English, user-visible text is German and goes through the i18n layer,
backend messages and mail texts are German-only in v1. Never weaken tests; never
commit secrets. Report vulnerabilities via GitHub Security Advisories (see
SECURITY.md).*

## Voraussetzungen

- Node 22 (LTS) und pnpm 11 (`packageManager` in `package.json`)
- Docker mit Compose v2, für die Integrationstests und zum Ausprobieren
- `bash` und `openssl` für `install.sh`

## Einrichtung

```bash
pnpm install
cp apps/control/.env.example apps/control/.env     # Werte anpassen
# PostgreSQL 16 bereitstellen (z. B. per Docker) und DATABASE_URL in apps/control/.env setzen
pnpm --filter @saas-instant/control exec prisma migrate dev
pnpm --filter @saas-instant/control dev            # Backend (Port 3001)
pnpm --filter @saas-instant/control dev:web        # Oberfläche (Vite, in einem zweiten Terminal)
```

Die Beispielwerte in `.env.example` sind Platzhalter. Lokal über HTTP
`COOKIE_SECURE=0` setzen, sonst sendet der Browser das Cookie nicht. Der
Seed-Befehl (`pnpm --filter @saas-instant/control seed`) legt ein Konto mit
bekanntem Passwort an. Er läuft nur mit `CONTROL_SEED_ALLOWED=ja`, nie in
Produktion.

Ein Gesamtlauf im Container: `./install.sh --mode single --software <slug>` (mit
`--dry-run` oder `--no-start` zum Ansehen). Details: [docs/installation.md](docs/installation.md).

## Tests und Prüfungen

| Befehl | Zweck |
|---|---|
| `pnpm lint` | Typprüfung aller Pakete (`tsc --noEmit`) |
| `pnpm test` | alle Tests (Backend mit Jest, Oberfläche und Pakete mit Vitest) |
| `pnpm build` | Build aller Pakete |
| `pnpm --filter @saas-instant/control test:integration` | Integrationstests gegen eine echte Datenbank |
| `bash tests/install.test.sh` | Test für `install.sh` und `bin/saas-instant` (ohne Start, Temp-Verzeichnis) |

`pnpm test` führt die Integrationstests aus, **wenn** eine Datenbank erreichbar ist,
und überspringt sie sonst laut sichtbar. Sie laufen gegen eine eigene Datenbank
(`<name>_integration`), nie gegen die Entwicklungsdatenbank. Vor einem Pull Request
sollten `pnpm lint` und `pnpm test` grün sein, möglichst mit Datenbank.

**Tests werden nicht abgeschwächt.** Schlägt ein Test fehl, wird der Code oder die
Annahme korrigiert, nicht der Test gelockert, übersprungen oder gelöscht. Ein Test
darf nur geändert werden, wenn sich das geprüfte Verhalten bewusst ändert, und das
gehört in die Beschreibung des Pull Requests. Besonders geschützt sind die
Abwesenheitstests, die die harten Regeln prüfen (etwa `coolify/no-delete-path.spec.ts`
und `invoices/invoice-immutable.spec.ts`, siehe
[docs/operations/security-model.md](docs/operations/security-model.md)). Eine neue
Ausnahme dort braucht eine ausdrückliche Begründung.

## Demo-Daten

Für Screenshots der Oberfläche legt `pnpm --filter @saas-instant/control seed:demo`
rein erfundene Beispieldaten an (8 Organisationen in verschiedenen Status, 6
Instanzen mit Kennzahlen der letzten 30 Tage, 7 Rechnungen, einige Notizen;
Adressen unter `example.com`, keine echten Namen oder IBANs). Voraussetzungen: der
Testbenutzer aus `seed` existiert, `CONTROL_SEED_ALLOWED=ja` ist gesetzt, und
`NODE_ENV` ist nicht `production`. Alle Datensätze haben feste IDs mit Präfix
`demo-`; ein erneuter Lauf ersetzt nur diese und berührt nichts anderes. Es werden
ausschließlich lokale Datenbankzeilen geschrieben, nie Coolify oder Instanzen (R1).

## Konventionen

- **Sprachregeln.** Bezeichner im Code sind **englisch** (Dateien, Klassen,
  Funktionen, Prisma-Modelle und -Felder, Routen, API-Felder, Audit-Aktionen). Sichtbare
  **Oberflächentexte sind deutsch** und stehen im Wörterbuch
  `apps/control/src/i18n/locales/de/` (Zugriff über `t('namespace.key')`, keine
  deutschen Literale in Komponenten, siehe [docs/i18n.md](docs/i18n.md)). **Backend-Meldungen
  und Mailtexte bleiben in v1 deutsch.** Fachbegriffe im Text (SEPA, Lastschrift,
  Mandat, USt-IdNr.) bleiben deutsch, als Bezeichner werden sie englisch
  (`creditorId`, `sepaMandateReference`). Die Zuordnung deutscher zu englischen Namen
  steht in [docs/rename-glossary.md](docs/rename-glossary.md). Fehlt ein Begriff,
  wähle einen naheliegenden englischen und trage ihn dort nach.
- **Namensschema.** Dateien im Backend in `kebab-case` (`invoice-payment.controller.ts`),
  React-Komponenten in `PascalCase`, Modelle und Enums in `PascalCase`, Felder in
  `camelCase`, Enum-Werte klein.
- **Datenmodell.** Fachliche Tagesdaten sind `@db.Date`, technische Zeitstempel
  `DateTime`. Änderungen am Schema kommen als neue, additive Migration unter
  `apps/control/prisma/migrations`. Bestehende Migrationen werden nicht verändert.
- **Harte Regeln beachten.** Kein Codepfad, der Deployments, Datenbanken oder
  Instanzen löscht (R1). Festgeschriebene Rechnungen bleiben unveränderlich (R2).
  Wer einen Schreibpfad hinzufügt, der an diese Regeln rührt, bringt den passenden
  Test mit.
- **Geheimnisse gehören nie ins Repository.** Keine Zugangsdaten, Tokens oder Schlüssel
  in Code, Tests, Beispieldateien, Logs, Issues oder Commits. Beispieldateien tragen
  erkennbare Platzhalter. `.env`, `installations/` und Dumps stehen in `.gitignore`.
- **Keine fremden Hosts und keine persönlichen Pfade** in Code, Kommentaren und
  Dokumentation. Für Beispiele `example.com` und Platzhalter wie `<verwaltung>`.
- **Kommentare** erklären das Warum. Wo eine Entscheidung eine Falle abwehrt, steht
  die Falle im Kommentar.
- **Formatierung** regelt `.editorconfig` (UTF-8, LF, zwei Leerzeichen).

## Pull Requests

1. Einen Zweig vom Hauptzweig abzweigen, kleine und thematisch zusammenhängende
   Änderungen machen.
2. Tests für das neue Verhalten ergänzen, `pnpm lint` und `pnpm test` laufen lassen.
3. Im Pull Request beschreiben, was sich ändert und warum, und ob Dokumentation
   (`docs/`) oder das Beispielmanifest mitgezogen werden mussten.
4. Dokumentation für den Betrieb liegt in `docs/operations/`. Wer Verhalten ändert,
   das dort beschrieben ist, passt das Dokument im selben Pull Request an.

Sicherheitslücken bitte **nicht** hier melden, sondern wie in [SECURITY.md](SECURITY.md)
beschrieben.

Mit einem Beitrag stimmst du zu, dass er unter der Lizenz des Projekts steht
(AGPL-3.0-only, siehe [LICENSE](LICENSE) und [NOTICE](NOTICE)).
