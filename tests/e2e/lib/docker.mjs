// Kleine Docker-Helfer. Alles, was die E2E-Tests anlegen, trägt das Label e2e=true.
// Aufräumen fasst NUR Ressourcen mit diesem Label an (nie Coolify/Instanzen, Regel R1).
import { spawn } from 'node:child_process';
import { sleep } from './util.mjs';

export const LABEL = 'e2e=true';

/** Führt einen Befehl aus. Liefert { code, stdout, stderr }; wirft bei Code != 0, sofern allowFail nicht gesetzt. */
export function run(cmd, args = [], { cwd, env, input, allowFail = false, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`Zeitüberschreitung: ${cmd} ${args.join(' ')}`));
    }, timeoutMs);
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      const r = { code, stdout, stderr };
      if (code !== 0 && !allowFail) {
        reject(new Error(`${cmd} ${args.join(' ')} endete mit ${code}: ${(stderr || stdout).trim().split('\n').slice(-5).join(' | ')}`));
      } else resolve(r);
    });
    if (input !== undefined) p.stdin.write(input);
    p.stdin.end();
  });
}

export const docker = (args, opts) => run('docker', args, opts);

/** compose-Aufruf mit festem Projektnamen (Präfix e2e-). */
export function compose(project, files, args, opts = {}) {
  const f = files.flatMap((x) => ['-f', x]);
  return docker(['compose', '-p', project, ...f, ...args], opts);
}
export const composeUp = (project, files, opts = {}) =>
  compose(project, files, ['up', '-d', '--build', '--wait'].filter((a) => !(opts.build === false && a === '--build')), opts);
export const composeDown = (project, files, opts = {}) =>
  compose(project, files, ['down', '-v', '--remove-orphans'], { allowFail: true, ...opts });

/** Wartet, bis ein Container "healthy" ist (oder, ohne Healthcheck, "running"). */
export async function waitHealthy(container, { timeoutMs = 120_000 } = {}) {
  const end = Date.now() + timeoutMs;
  let state = '';
  while (Date.now() < end) {
    const r = await docker(
      ['inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', container],
      { allowFail: true },
    );
    state = r.stdout.trim();
    if (state === 'healthy' || (state === 'running' && !(await hasHealthcheck(container)))) return state;
    if (state === 'exited' || state === 'dead') break;
    await sleep(1000);
  }
  throw new Error(`Container ${container} nicht bereit (Zustand: ${state || 'unbekannt'})`);
}
async function hasHealthcheck(container) {
  const r = await docker(['inspect', '-f', '{{if .State.Health}}ja{{end}}', container], { allowFail: true });
  return r.stdout.trim() === 'ja';
}

export async function logs(container, tail = 100) {
  const r = await docker(['logs', '--tail', String(tail), container], { allowFail: true });
  return `${r.stdout}${r.stderr}`;
}

/** Entfernt alle Container, Netzwerke und Volumes mit Label e2e=true. */
export async function cleanup() {
  const removed = { containers: 0, networks: 0, volumes: 0 };
  const ping = await docker(['info'], { allowFail: true, timeoutMs: 20_000 }).catch(() => ({ code: 1 }));
  if (ping.code !== 0) return removed;
  // Ressourcen mit zusätzlichem Label e2e.suite=<name> gehören einer Suite, die sie selbst aufräumt
  // (parallele Läufe): sie werden nur entfernt, wenn E2E_CLEAN_SUITE denselben Namen (oder "all") trägt.
  const mineSuite = process.env.E2E_CLEAN_SUITE || '';
  const ids = async (kind) => {
    const fmt = kind === 'container' ? '{{.ID}}|{{.Label "e2e.suite"}}' : kind === 'volume' ? '{{.Name}}|{{.Label "e2e.suite"}}' : '{{.ID}}|{{.Label "e2e.suite"}}';
    const r = await docker([kind, 'ls', ...(kind === 'container' ? ['-a'] : []), '--filter', `label=${LABEL}`, '--format', fmt], { allowFail: true });
    return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split('|'))
      .filter(([, suite]) => !suite || suite === mineSuite || mineSuite === 'all')
      .map(([id]) => id);
  };
  const cs = await ids('container');
  if (cs.length) await docker(['rm', '-f', '-v', ...cs], { allowFail: true });
  removed.containers = cs.length;
  const ns = await ids('network');
  if (ns.length) await docker(['network', 'rm', ...ns], { allowFail: true });
  removed.networks = ns.length;
  const vs = await ids('volume');
  if (vs.length) await docker(['volume', 'rm', '-f', ...vs], { allowFail: true });
  removed.volumes = vs.length;
  return removed;
}
