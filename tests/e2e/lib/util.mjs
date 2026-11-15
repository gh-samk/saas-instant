// Gemeinsame Helfer der E2E-Suiten: Schritte, Ergebnis-JSON, Timeouts, Zustand.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const E2E_OUT = process.env.E2E_OUT || join(tmpdir(), 'saas-instant-e2e');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Bricht nach ms ab; `label` erscheint in der Fehlermeldung. */
export function withTimeout(promise, ms, label = 'Vorgang') {
  let timer;
  const t = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`Zeitüberschreitung (${ms} ms): ${label}`)), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

/** Wiederholt fn bis sie truthy liefert oder die Zeit abläuft. */
export async function waitFor(fn, { timeoutMs = 60_000, intervalMs = 500, label = 'Bedingung' } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Zeitüberschreitung (${timeoutMs} ms): ${label}${last ? ` (${last.message})` : ''}`);
}

export function suiteDir(suite) {
  const d = join(E2E_OUT, suite);
  mkdirSync(d, { recursive: true });
  return d;
}

/** Zustandsdatei für das Aufräumen (Prozesse, Datenbanken). */
const statePath = () => {
  mkdirSync(E2E_OUT, { recursive: true });
  return join(E2E_OUT, '.state.json');
};
export function readState() {
  try {
    return existsSync(statePath()) ? JSON.parse(readFileSync(statePath(), 'utf8')) : { pids: [], dbs: [] };
  } catch {
    return { pids: [], dbs: [] };
  }
}
export function updateState(fn) {
  const s = readState();
  fn(s);
  writeFileSync(statePath(), JSON.stringify(s));
}

/**
 * Eine Suite: step(name, fn) druckt je Schritt genau eine Zeile.
 * finish() schreibt ${E2E_OUT}/<suite>/result.json und setzt den Exit-Code.
 */
export function createSuite(name, { stepTimeoutMs = 120_000 } = {}) {
  const dir = suiteDir(name);
  const steps = [];
  const started = Date.now();
  async function step(title, fn, { timeoutMs = stepTimeoutMs } = {}) {
    const t0 = Date.now();
    let result;
    try {
      const value = await withTimeout(Promise.resolve().then(fn), timeoutMs, title);
      result = { name: title, status: 'PASS', ms: Date.now() - t0 };
      console.log(`PASS ${name}/${title} (${result.ms} ms)`);
      steps.push(result);
      return value;
    } catch (e) {
      const msg = String(e?.message ?? e).split('\n')[0].slice(0, 300);
      result = { name: title, status: 'FAIL', ms: Date.now() - t0, error: msg };
      console.log(`FAIL ${name}/${title}: ${msg}`);
      steps.push(result);
      return undefined;
    }
  }
  function finish() {
    const failed = steps.filter((s) => s.status === 'FAIL').length;
    const out = {
      suite: name,
      ok: failed === 0 && steps.length > 0,
      passed: steps.length - failed,
      failed,
      durationMs: Date.now() - started,
      steps,
    };
    writeFileSync(join(dir, 'result.json'), JSON.stringify(out, null, 2));
    console.log(`${out.ok ? 'OK' : 'FEHLER'} ${name}: ${out.passed}/${steps.length} Schritte bestanden`);
    process.exitCode = out.ok ? 0 : 1;
    return out;
  }
  return { name, dir, step, finish, steps };
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
