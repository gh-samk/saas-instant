#!/usr/bin/env node
/**
 * Führt die Integrationstests des Anmeldedienstes aus, WENN eine Datenbank
 * erreichbar ist, und sagt laut Bescheid, wenn nicht.
 *
 * Gelaufen wird IMMER gegen eine eigene Datenbank (`portal_auth_test`), nie
 * gegen die, auf die DATABASE_URL zeigt: Host, Port und Zugangsdaten werden
 * übernommen, der Datenbankname ersetzt. Geleert wird nur, wenn der Name auf
 * `_test` endet.
 */
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DB = 'portal_auth_test';

function sourceUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const content = readFileSync(join(ROOT, '.env'), 'utf8');
    const m = /^\s*DATABASE_URL\s*=\s*(.+?)\s*$/m.exec(content);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  } catch {
    /* keine .env */
  }
  return null;
}

const REQUIRED = process.env.INTEGRATION_REQUIRED === '1' || (!!process.env.CI && process.env.INTEGRATION_REQUIRED !== '0');
function skip(reason) {
  if (REQUIRED) {
    process.stderr.write(`INTEGRATIONSTESTS NICHT AUSGEFÜHRT, aber verpflichtend: ${reason}\n`);
    process.exit(1);
  }
  process.stdout.write(`\nINTEGRATIONSTESTS ÜBERSPRUNGEN: ${reason}\n  (Postgres starten und DATABASE_URL setzen.)\n\n`);
  process.exit(0);
}

const raw = sourceUrl();
if (!raw) skip('DATABASE_URL ist weder gesetzt noch in apps/portal-auth/.env zu finden.');
let target;
try {
  target = new URL(raw);
} catch {
  skip('DATABASE_URL ist keine gültige URL.');
}
const name = decodeURIComponent(target.pathname).replace(/^\//, '');
target.pathname = `/${name.endsWith('_test') ? name : TEST_DB}`;
const url = target.toString();
const databaseName = decodeURIComponent(target.pathname).replace(/^\//, '');

const reachable = await new Promise((done) => {
  const c = connect({ host: target.hostname || 'localhost', port: Number(target.port || 5432), timeout: 1500 });
  const finish = (ok) => { c.destroy(); done(ok); };
  c.once('connect', () => finish(true));
  c.once('timeout', () => finish(false));
  c.once('error', () => finish(false));
});
if (!reachable) skip(`Auf ${target.hostname}:${target.port || 5432} horcht niemand.`);

const prisma = join(ROOT, 'node_modules', '.bin', 'prisma');
const env = { ...process.env, DATABASE_URL: url };
process.stdout.write(`\nIntegrationstests gegen ${target.hostname}:${target.port || 5432}/${databaseName} …\n`);

const prepared = spawnSync(prisma, ['migrate', 'deploy'], { cwd: ROOT, stdio: 'inherit', env });
if (prepared.status !== 0) skip(`Die Testdatenbank ${databaseName} liess sich nicht vorbereiten.`);
const generated = spawnSync(prisma, ['generate'], { cwd: ROOT, stdio: 'ignore', env });
if (generated.status !== 0) process.stdout.write('Hinweis: prisma generate schlug fehl; vorhandener Client wird genutzt.\n');

if (databaseName.endsWith('_test')) {
  spawnSync(prisma, ['db', 'execute', '--stdin', '--url', url], {
    cwd: ROOT,
    input: `DO $$ DECLARE t text; BEGIN FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' LOOP EXECUTE format('TRUNCATE TABLE %I CASCADE', t); END LOOP; END $$;`,
    encoding: 'utf8',
  });
}

const run = spawnSync(join(ROOT, 'node_modules', '.bin', 'jest'), ['--config', 'jest.integration.config.ts', ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: 'inherit',
  env,
});
process.exit(run.status ?? 1);
