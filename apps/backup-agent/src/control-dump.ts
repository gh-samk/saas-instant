import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import type { ExecHandle } from './docker/types.js';

/** Lokaler pg_dump der Verwaltungs-DB. Zugangsdaten gehen ueber die Umgebung, nicht ueber die Argumente. */
export function localPgDump(connectionString: string): ExecHandle {
  const u = new URL(connectionString);
  const env = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')),
  };
  const child = spawn('pg_dump', ['-Fc'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = new PassThrough();
  child.stdout.pipe(stdout);
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => {
    if (stderr.length < 8192) stderr += c.toString('utf8');
  });
  const done = new Promise<{ exitCode: number; stderr: string }>((resolve) => {
    child.on('error', (e) => {
      stdout.end();
      resolve({ exitCode: -1, stderr: e.message });
    });
    child.on('close', (code) => resolve({ exitCode: code ?? -1, stderr }));
  });
  return { stdout, done };
}
