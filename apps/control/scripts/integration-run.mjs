#!/usr/bin/env node
/**
 * Führt die Integrationstests aus, WENN eine Datenbank erreichbar ist —
 * und sagt laut Bescheid, wenn nicht.
 *
 * Hintergrund: Der einzige automatisierte Schutz gegen die Rückkehr des
 * Rennens im Sperrzähler ist `sperre.integration.spec.ts`. Lief er nur über
 * ein eigenes Skript, das man kennen und von Hand aufrufen muss, wäre er im
 * Alltag wirkungslos. Deshalb hängt er an `pnpm test`.
 *
 * Ist keine Datenbank da, wird ÜBERSPRUNGEN statt fehlgeschlagen — sonst
 * könnte niemand ohne Docker testen. Das Überspringen ist aber deutlich
 * sichtbar und nennt den Befehl, der die Datenbank startet.
 *
 * Gelaufen wird gegen eine EIGENE Datenbank (`…_integration`), niemals gegen
 * die Entwicklungsdatenbank — siehe `mitEigenerDatenbank`.
 */
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WAIT_TIME_MS = 1500;

/**
 * Hängt `_integration` an den Datenbanknamen an.
 *
 * Der Integrationslauf legt Konten an, zählt Sperrzähler hoch und räumt am Ende
 * per `deleteMany` auf — ein abgebrochener Lauf lässt Reste stehen. Lief das
 * gegen die Entwicklungsdatenbank, störte es jeden, der dort gerade arbeitete;
 * genau daher kamen die gegenseitigen Störungen dieser Sitzung ([H8]).
 *
 * Deshalb dieselbe Lösung wie in `apps/web/e2e/datenbank.ts`: Host, Port und
 * Zugangsdaten der Entwicklungsumgebung übernehmen, aber NIE deren Datenbank.
 */
function withOwnDatabase(url) {
  try {
    const target = new URL(url);
    const name = decodeURIComponent(target.pathname).replace(/^\//, '');
    if (!name) return null;
    if (name.endsWith('_integration')) return target.toString();
    target.pathname = `/${name}_integration`;
    return target.toString();
  } catch {
    return null;
  }
}

/**
 * Liest DATABASE_URL aus der Umgebung oder aus apps/control/.env und leitet
 * daraus die EIGENE Integrationsdatenbank ab.
 */
function databaseUrl() {
  const raw = (() => {
    if (process.env.DATABASE_URL) {
      return { url: process.env.DATABASE_URL, source: 'Umgebungsvariable' };
    }
    try {
      const content = readFileSync(join(PACKAGE_ROOT, '.env'), 'utf8');
      for (const line of content.split('\n')) {
        const match = /^\s*DATABASE_URL\s*=\s*(.+?)\s*$/.exec(line);
        if (match) {
          return { url: match[1].replace(/^["']|["']$/g, ''), source: '.env' };
        }
      }
    } catch {
      // Keine .env — behandeln wie „nicht gesetzt".
    }
    return { url: null, source: null };
  })();

  if (!raw.url) return raw;
  const own = withOwnDatabase(raw.url);
  if (!own) return { url: null, source: raw.source };
  return { url: own, source: `${raw.source}, eigene Integrationsdatenbank` };
}

/** Prüft, ob auf Host:Port überhaupt jemand horcht. */
function reachable(host, port) {
  return new Promise((done) => {
    const connection = connect({ host, port, timeout: WAIT_TIME_MS });
    const finish = (result) => {
      connection.destroy();
      done(result);
    };
    connection.once('connect', () => finish(true));
    connection.once('timeout', () => finish(false));
    connection.once('error', () => finish(false));
  });
}

// In CI (oder mit INTEGRATION_REQUIRED=1) ist Überspringen ein FEHLER: Ohne
// Datenbank liefe das Roh-SQL der Kontosperre ungeprüft, und ein Spaltenfehler
// dort bliebe unbemerkt (jeder Fehlversuch würde zum 500, die Sperre griffe nie).
const REQUIRED =
  process.env.INTEGRATION_REQUIRED === '1' ||
  (!!process.env.CI && process.env.INTEGRATION_REQUIRED !== '0');

function skipped(reason) {
  if (REQUIRED) {
    process.stderr.write(
      `INTEGRATIONSTESTS NICHT AUSGEFÜHRT, aber verpflichtend: ${reason}\n`,
    );
    process.exit(1);
  }
  const frame = '─'.repeat(74);
  process.stdout.write(
    [
      '',
      frame,
      '  INTEGRATIONSTESTS ÜBERSPRUNGEN — keine Datenbank erreichbar.',
      `  Grund: ${reason}`,
      '',
      '  Damit läuft die Absicherung gegen das Rennen im Sperrzähler NICHT.',
      '  Vor einer Abnahme bitte mit Datenbank ausführen:',
      '',
      '    docker compose --profile control up -d control-db',
      '    pnpm --filter @saas-instant/control test:integration',
      '',
      frame,
      '',
    ].join('\n'),
  );
}

const { url, source } = databaseUrl();
if (!url) {
  skipped('DATABASE_URL ist weder gesetzt noch in apps/control/.env zu finden.');
  process.exit(0);
}

let target;
try {
  target = new URL(url);
} catch {
  skipped(`DATABASE_URL (${source}) ist keine gültige URL.`);
  process.exit(0);
}

const host = target.hostname || 'localhost';
const port = Number(target.port || '5432');

if (!(await reachable(host, port))) {
  skipped(`Auf ${host}:${port} (aus ${source}) horcht niemand.`);
  process.exit(0);
}

const databaseName = decodeURIComponent(new URL(url).pathname).replace(/^\//, '');
process.stdout.write(
  `\nIntegrationstests gegen ${host}:${port}/${databaseName} (aus ${source}) …\n`,
);

// Eigene Datenbank anlegen und auf den Schemastand bringen. `migrate deploy`
// ist idempotent; existiert die Datenbank schon, passiert beim zweiten Mal
// nichts. Bewusst KEIN `migrate reset`: das Skript soll auch dann nichts
// zerstören können, wenn die abgeleitete URL wider Erwarten woandershin zeigt.
const preparation = spawnSync(
  join(PACKAGE_ROOT, 'node_modules', '.bin', 'prisma'),
  ['migrate', 'deploy'],
  { cwd: PACKAGE_ROOT, stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } },
);
if (preparation.status !== 0) {
  skipped(
    `Die Integrationsdatenbank ${databaseName} liess sich nicht vorbereiten.`,
  );
  process.exit(0);
}

// LEEREN VOR DEM LAUF — und ausschliesslich hier.
//
// Die Suiten raeumen am Ende per `deleteMany` auf; ein abgebrochener Lauf tut
// das nicht. Gemessen am 31.08.2026 lagen so 4462 Audit-Zeilen, 426 Notizen
// und 285 Organisationen aus fruehreren Abbruechen in der Datenbank. Das ist
// kein Datenverlustrisiko, aber es macht jede Zaehlung, die nicht auf ein
// Praefix filtert, langsam still falsch.
//
// DIE SCHRANKE IST DER NAME, nicht das Vertrauen: Nur eine Datenbank, deren
// Name auf `_integration` endet, wird angefasst. Zeigte die abgeleitete URL
// wider Erwarten woandershin, passiert hier nichts — dieselbe Vorsicht, aus
// der oben `migrate reset` nicht verwendet wird.
if (databaseName.endsWith('_integration')) {
  const cleared = spawnSync(
    join(PACKAGE_ROOT, 'node_modules', '.bin', 'prisma'),
    ['db', 'execute', '--stdin', '--url', url],
    {
      cwd: PACKAGE_ROOT,
      input: `DO $$
DECLARE table text;
BEGIN
  FOR table IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  LOOP
    EXECUTE format('TRUNCATE TABLE %I CASCADE', table);
  END LOOP;
END $$;`,
      encoding: 'utf8',
    },
  );
  if (cleared.status !== 0) {
    process.stdout.write(
      `Hinweis: ${databaseName} liess sich nicht leeren — der Lauf geht ` +
        'trotzdem weiter, die Suiten filtern auf eigene Praefixe.\n',
    );
  }
} else {
  process.stdout.write(
    `Hinweis: ${databaseName} endet nicht auf _integration — nicht geleert.\n`,
  );
}

// Bewusst die LOKALEN Binärdateien statt `npx`: `npx prisma` griff auf eine
// global zwischengespeicherte Fassung zu, deren Befehle sich von der im Projekt
// festgelegten unterscheiden.
// Eigene Argumente werden DURCHGEREICHT. Ohne das liess sich ein sporadischer
// Fehlschlag nicht festhalten: Mit `--verbose` nennt die Ausgabe jeden Fall
// einzeln, und erst dann steht in einer mitgeschriebenen Datei, WELCHER Test
// umgekippt ist. Genau so wurde der Rennfall in `instanz.integration.spec.ts`
// am 07.09.2026 gefasst.
const run = spawnSync(
  join(PACKAGE_ROOT, 'node_modules', '.bin', 'jest'),
  ['--config', 'jest.integration.config.ts', ...process.argv.slice(2)],
  { cwd: PACKAGE_ROOT, stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } },
);
process.exit(run.status ?? 1);
