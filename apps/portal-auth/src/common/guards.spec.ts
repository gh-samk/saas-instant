import 'reflect-metadata';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Controller, Post, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser = require('cookie-parser');
import { CONFIG, type PortalConfig } from '../config';
import { CsrfGuard, WithoutCsrf } from './guards';

@Controller('api/me')
class ProbeMe {
  @Post('password')
  change(): { changed: true } {
    return { changed: true };
  }
}

@Controller('oauth')
class ProbeOauth {
  @WithoutCsrf('Test: Server-zu-Server, kein Cookie.')
  @Post('token')
  token(): { token: true } {
    return { token: true };
  }
}

const config = { origin: 'https://portal.example.test', cookieSecure: false } as PortalConfig;

function raw(
  port: number,
  target: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target, method: 'POST', headers }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('CsrfGuard', () => {
  let app: INestApplication;
  let port: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeMe, ProbeOauth],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: APP_GUARD, useClass: CsrfGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });
  afterAll(async () => {
    await app.close();
  });

  // Express ordnet diese Schreibweisen derselben Route zu. Die frühere
  // Pfadprüfung (`startsWith('/api/')`) übersprang die CSRF-Prüfung dafür.
  it.each([
    ['/api/me/password'],
    ['/API/me/password'],
    ['/Api/Me/Password'],
    ['/api/me/password/'],
    ['http://portal.example.test/api/me/password'],
    ['http://portal.example.test/API/me/password'],
  ])('POST %s ohne CSRF-Token -> 403 csrf_invalid', async (target) => {
    const res = await raw(port, target);
    expect(res.status).toBe(403);
    expect(res.body).toContain('csrf_invalid');
  });

  it('mit passendem Cookie und Header läuft die Anfrage durch', async () => {
    const res = await raw(port, '/API/me/password', {
      cookie: 'portal_csrf=abc123',
      'x-csrf-token': 'abc123',
    });
    expect(res.status).toBe(201);
  });

  it('fremde Herkunft wird abgelehnt', async () => {
    const res = await raw(port, '/API/me/password', {
      origin: 'https://boese.example.test',
      cookie: 'portal_csrf=abc123',
      'x-csrf-token': 'abc123',
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain('csrf_origin');
  });

  it('der markierte Server-zu-Server-Weg braucht kein Token', async () => {
    expect((await raw(port, '/oauth/token')).status).toBe(201);
  });
});
