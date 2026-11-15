// Mock-Coolify für die Suite "backup": bildet genau die Endpunkte nach, die der CoolifyProvisioner
// für create/status/stop aufruft (siehe apps/control/src/coolify/coolify.client.ts).
//  - 'create' (POST /applications/private-deploy-key) liefert eine UUID und markiert die Anwendung;
//  - ein Ausrollen (POST /deploy) setzt sie auf "running" ("Instanz läuft", Gesundheit antwortet 200);
//  - 'stop' wird mitgeschrieben;
//  - JEDER DELETE wird abgelehnt (405) UND als Verstoß gegen Regel R1 festgehalten (forbiddenDelete).
// Alle Aufrufe stehen in `calls` (Methode, Pfad, Zeit; Rümpfe nur als Feldnamen, nie Werte).
// Zusätzlich: GET /__instance/<host>/<pfad> beantwortet die Gesundheitsprüfung der Verwaltung
// (dorthin leitet preload-fetch.cjs https://*.e2e.example.com um): 200 nur, wenn eine laufende
// Anwendung diese Domäne trägt.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

export function startMockCoolify({ port = 13091, seed = [] } = {}) {
  const apps = new Map();
  const deployments = new Map();
  const calls = [];
  let depCount = 0;
  for (const a of seed) apps.set(a.uuid, { status: 'running', domains: [], env: [], ...a });

  const view = (a) => ({
    uuid: a.uuid,
    name: a.name,
    status: a.status,
    docker_compose_domains: a.domains.map((d) => ({ name: 'web', domain: `https://${d}` })),
  });

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://mock');
      const path = url.pathname.replace(/^\/api\/v1/, '');
      let body = null;
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch { body = null; }
      const entry = { time: new Date().toISOString(), method: req.method, path };
      if (path.startsWith('/__')) {
        // Interner Weg (Gesundheit, Mitschrift): nicht in der Mitschrift der Coolify-API.
      } else {
        if (body && typeof body === 'object' && !Array.isArray(body)) entry.fields = Object.keys(body);
        if (path.endsWith('/envs') && body?.key) entry.envKey = String(body.key);
        calls.push(entry);
      }
      const send = (status, json) => {
        const payload = json === undefined ? '' : typeof json === 'string' ? json : JSON.stringify(json);
        res.writeHead(status, { 'content-type': typeof json === 'string' ? 'text/plain' : 'application/json' });
        res.end(payload);
      };

      if (req.method === 'DELETE') {
        entry.forbiddenDelete = true;
        return send(405, { message: 'DELETE ist im Mock nicht vorgesehen (Regel R1)' });
      }
      let m;
      if (req.method === 'GET' && path === '/__calls') return send(200, calls);
      if (req.method === 'GET' && (m = /^\/__instance\/([^/]+)(\/.*)?$/.exec(path))) {
        const host = m[1].toLowerCase();
        const up = [...apps.values()].some((a) => a.status === 'running' && a.domains.includes(host));
        return send(up ? 200 : 503, { ok: up });
      }
      if (req.method === 'GET' && path === '/version') return send(200, '4.0.0-mock');
      if (req.method === 'GET' && path === '/applications') return send(200, [...apps.values()].map(view));
      if (req.method === 'GET' && (m = /^\/applications\/([^/]+)$/.exec(path))) {
        const a = apps.get(m[1]);
        return a ? send(200, view(a)) : send(404, { message: 'Not found' });
      }
      if (req.method === 'POST' && path === '/applications/private-deploy-key') {
        const uuid = `mock-${randomBytes(6).toString('hex')}`;
        apps.set(uuid, { uuid, name: String(body?.name ?? ''), status: 'exited', domains: [], env: [], created: true });
        return send(201, { uuid });
      }
      if ((m = /^\/applications\/([^/]+)\/envs$/.exec(path)) && ['POST', 'PATCH'].includes(req.method)) {
        const a = apps.get(m[1]);
        if (!a) return send(404, { message: 'Not found' });
        const key = String(body?.key ?? '');
        const has = a.env.includes(key);
        if (req.method === 'POST' && has) return send(409, { message: 'exists' });
        if (req.method === 'PATCH' && !has) return send(404, { message: 'missing' });
        if (!has) a.env.push(key);
        return send(req.method === 'POST' ? 201 : 200, { uuid: `env-${key}` });
      }
      if (req.method === 'PATCH' && (m = /^\/applications\/([^/]+)$/.exec(path))) {
        const a = apps.get(m[1]);
        if (!a) return send(404, { message: 'Not found' });
        const doms = Array.isArray(body?.docker_compose_domains) ? body.docker_compose_domains : [];
        a.domains = doms.map((d) => String(d.domain ?? '').replace(/^https?:\/\//, '').toLowerCase()).filter(Boolean);
        return send(200, { uuid: a.uuid });
      }
      if (req.method === 'POST' && path === '/deploy') {
        const uuid = url.searchParams.get('uuid');
        const a = apps.get(uuid ?? '');
        if (!a) return send(404, { message: 'Not found' });
        const id = `dep-${++depCount}`;
        deployments.set(id, uuid);
        a.status = 'running';
        a.deployed = (a.deployed ?? 0) + 1;
        return send(200, { deployments: [{ deployment_uuid: id }] });
      }
      if (req.method === 'GET' && (m = /^\/deployments\/([^/]+)$/.exec(path))) {
        return deployments.has(m[1]) ? send(200, { status: 'finished', commit: COMMIT }) : send(404, { message: 'Not found' });
      }
      if (req.method === 'POST' && (m = /^\/applications\/([^/]+)\/stop$/.exec(path))) {
        const a = apps.get(m[1]);
        if (!a) return send(404, { message: 'Not found' });
        a.status = 'exited';
        a.stopped = true;
        return send(200, { message: 'stopped' });
      }
      entry.unhandled = true;
      return send(404, { message: `Mock kennt ${req.method} ${path} nicht` });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        calls,
        apps,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// Einzelstart: node mock-coolify.mjs [port]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const m = await startMockCoolify({ port: Number(process.argv[2] ?? 13091) });
  console.log(`mock-coolify auf ${m.url}`);
}
