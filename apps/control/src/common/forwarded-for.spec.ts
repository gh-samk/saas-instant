// eslint-disable-next-line @typescript-eslint/no-require-imports
const express = require('express') as typeof import('express');
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * F4-Nachtrag: Die Adresse im Rate-Limit kommt aus X-Forwarded-For, gezählt
 * von RECHTS (`trust proxy` = Zahl der Stationen). Das nginx von control-web
 * HÄNGT an; ein vom Client vorangestellter Eintrag darf deshalb nie zur
 * Adresse werden, solange der Wert zur Kette passt.
 */
const ROOT = join(__dirname, '../../../..');
const nginx = readFileSync(join(__dirname, '../../nginx.conf'), 'utf8');

async function ipSeenBy(trust: number, forwardedFor: string): Promise<string> {
  const app = express();
  app.set('trust proxy', trust);
  app.get('/', (req, res) => {
    res.send(req.ip);
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { 'x-forwarded-for': forwardedFor },
    });
    return await response.text();
  } finally {
    server.close();
  }
}

describe('X-Forwarded-For und CONTROL_TRUST_PROXY', () => {
  it('nginx hängt an (jede /api-Location), es ersetzt nicht und glaubt nichts ungeprüft', () => {
    const lines = nginx
      .split('\n')
      .filter((l) => /proxy_set_header\s+X-Forwarded-For/.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(line).toContain('$proxy_add_x_forwarded_for');
    expect(nginx).not.toMatch(/^\s*(set_real_ip_from|real_ip_header)/m);
  });

  it('Compose-Kette (ein Proxy, Wert 1): gefälschter Vorspann zählt nicht', async () => {
    // nginx hat „<Fälschung>" um die echte Adresse ergänzt.
    expect(await ipSeenBy(1, '6.6.6.6, 198.51.100.7')).toBe('198.51.100.7');
  });

  it('Coolify-Kette (Traefik + nginx, Wert 2): echte Client-Adresse', async () => {
    expect(await ipSeenBy(2, '6.6.6.6, 198.51.100.7, 10.0.0.2')).toBe('198.51.100.7');
  });

  it('die Compose-Vorgaben passen zur Kette', () => {
    const coolify = readFileSync(
      join(ROOT, 'reference/docker-compose.control.coolify.yml'),
      'utf8',
    );
    const local = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
    expect(coolify).toMatch(/CONTROL_TRUST_PROXY: \$\{CONTROL_TRUST_PROXY:-2\}/);
    expect(local).toMatch(/CONTROL_TRUST_PROXY: \$\{CONTROL_TRUST_PROXY:-1\}/);
  });
});
