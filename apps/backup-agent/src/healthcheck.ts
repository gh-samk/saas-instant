// Docker-HEALTHCHECK: signiert die Anfrage selbst mit BACKUP_AGENT_SECRET.
import http from 'node:http';
import { signRequest } from './hmac.js';

const secret = process.env['BACKUP_AGENT_SECRET'] ?? '';
const port = Number(process.env['PORT'] ?? 8787);
const req = http.request(
  { host: '127.0.0.1', port, path: '/v1/health', method: 'GET', headers: signRequest(secret, 'GET', '/v1/health'), timeout: 4000 },
  (res) => {
    res.resume();
    process.exit(res.statusCode === 200 ? 0 : 1);
  },
);
req.on('error', () => process.exit(1));
req.on('timeout', () => process.exit(1));
req.end();
