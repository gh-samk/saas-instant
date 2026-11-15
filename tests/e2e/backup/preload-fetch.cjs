// Nur für die E2E-Suite "backup": leitet die Gesundheitsprüfung der Verwaltung
// (fetch https://<sub>.e2e.example.com/...) auf den Mock-Coolify um, weil es diese Hosts nicht gibt.
// Wird über NODE_OPTIONS=--require=... in den Control-Prozess geladen; Produktcode bleibt unberührt.
const mock = process.env.E2E_MOCK_COOLIFY_URL;
const realFetch = globalThis.fetch;
if (mock && typeof realFetch === 'function') {
  globalThis.fetch = (input, init) => {
    try {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const u = new URL(raw);
      if (u.protocol === 'https:' && u.hostname.endsWith('.e2e.example.com')) {
        return realFetch(`${mock}/__instance/${u.hostname}${u.pathname}${u.search}`, init);
      }
    } catch { /* unverändert weiter */ }
    return realFetch(input, init);
  };
}
