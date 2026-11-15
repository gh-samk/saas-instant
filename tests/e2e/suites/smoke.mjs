// Smoke-Test: Control-API startet, Login (Passwort + TOTP) klappt, GET /api/public-config antwortet.
import { startControl } from '../lib/control.mjs';
import { createSuite, assert } from '../lib/util.mjs';

const s = createSuite('smoke');
let ctl;
try {
  ctl = await s.step('control startet (build, migrate, seed, health)', () => startControl({ dbName: 'e2e_smoke', suite: 'smoke' }), { timeoutMs: 600_000 });
  if (ctl) {
    const session = await s.step('login mit Passwort + TOTP', async () => {
      const c = await ctl.login();
      const me = await c.api('GET', '/api/auth/me');
      assert(me.ok, `GET /api/auth/me -> ${me.status}`);
      return c;
    });
    await s.step('GET /api/public-config', async () => {
      const r = await (session?.api ?? (async (m, p) => ({ status: (await fetch(ctl.url + p)).status })))('GET', '/api/public-config');
      assert(r.status === 200, `HTTP ${r.status}`);
    });
  }
} finally {
  if (ctl) await ctl.stop();
  s.finish();
}
