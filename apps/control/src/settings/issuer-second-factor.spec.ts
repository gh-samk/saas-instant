import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { emptyIssuerProfile } from '@saas-instant/shared';
import { AccessService } from '../auth/access.service';
import { SessionGuard } from '../common/guards/session.guard';
import { LoginFailedError } from '../common/errors/business-error';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { IssuerSettingsController } from './issuer.controller';
import { IssuerProfileService } from './issuer-profile.service';

/**
 * [M12] Firmendaten, Logo und Übertragungsvermerk gegen die ECHTEN Guards und
 * die globale Validierung: Ohne frische Sitzung (über zehn Minuten) und ohne
 * Nachweis kommt 401 — nicht 400 (unbekannte Felder) und nicht 200.
 *
 * Die Prüfung des Nachweises selbst (Passwort/TOTP, Sperre) steht im
 * `AccessService`; hier ist er durch eine Attrappe ersetzt, die die Regel
 * „frisch oder Nachweis stimmt" nachbildet.
 */

const PASSWORD = 'richtiges-passwort';
const FRESH_MS = 10 * 60 * 1000;

describe('Firmendaten hinter dem zweiten Faktor', () => {
  let app: INestApplication;
  let base: string;
  let sessionAgeMs = FRESH_MS * 5;
  const writes: string[] = [];

  beforeAll(async () => {
    const issuer = {
      update: jest.fn(async () => {
        writes.push('update');
        return { ok: true };
      }),
      setLogo: jest.fn(async (data: Buffer) => {
        writes.push(`logo:${data.length}`);
        return { ok: true };
      }),
      deleteLogo: jest.fn(async () => {
        writes.push('delete');
        return { ok: true };
      }),
      getResponse: jest.fn(async () => ({ ok: true })),
    };
    const access = {
      checkSecondFactor: jest.fn(
        async (
          _userId: string,
          evidence: { currentPassword?: string },
          _source: unknown,
          evidenceAt: Date | null,
        ) => {
          if (evidenceAt && Date.now() - evidenceAt.getTime() < FRESH_MS) return;
          if (evidence.currentPassword === PASSWORD) return;
          throw new LoginFailedError();
        },
      ),
    };
    const module = await Test.createTestingModule({
      controllers: [IssuerSettingsController],
      providers: [
        { provide: IssuerProfileService, useValue: issuer },
        { provide: AccessService, useValue: access },
      ],
    })
      .overrideGuard(SessionGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp: () => { getRequest: () => Record<string, unknown> };
        }) => {
          const req = context.switchToHttp().getRequest();
          req['user'] = { id: 'u1', username: 'sam' };
          req['accessRole'] = 'admin';
          req['sessionEvidenceAt'] = new Date(Date.now() - sessionAgeMs);
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    // Wie `main.ts`.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    writes.length = 0;
    sessionAgeMs = FRESH_MS * 5;
  });

  const evidenceHeader = (evidence: object) =>
    Buffer.from(JSON.stringify(evidence), 'utf8').toString('base64');
  const profile = { profile: emptyIssuerProfile('gmbh'), accentColor: '#0369a1' };
  const json = { 'Content-Type': 'application/json' };
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('PUT: 401 ohne Nachweis nach über zehn Minuten, nichts wird geschrieben', async () => {
    const response = await fetch(`${base}/settings/issuer`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify(profile),
    });
    expect(response.status).toBe(401);
    expect(writes).toEqual([]);
  });

  it('PUT: nimmt currentPassword im Body an (kein 400) und speichert', async () => {
    const response = await fetch(`${base}/settings/issuer`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ ...profile, currentPassword: PASSWORD }),
    });
    expect(response.status).toBe(200);
    expect(writes).toEqual(['update']);
  });

  it('PUT: weist ein falsches Passwort ab', async () => {
    const response = await fetch(`${base}/settings/issuer`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ ...profile, currentPassword: 'falsch' }),
    });
    expect(response.status).toBe(401);
    expect(writes).toEqual([]);
  });

  it('PUT: eine frische Sitzung braucht keinen Nachweis', async () => {
    sessionAgeMs = 60_000;
    const response = await fetch(`${base}/settings/issuer`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify(profile),
    });
    expect(response.status).toBe(200);
  });

  it('POST logo (rohes Bild): 401 ohne Nachweis, Erfolg mit Nachweis im Kopf', async () => {
    const without = await fetch(`${base}/settings/issuer/logo`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: png,
    });
    expect(without.status).toBe(401);
    expect(writes).toEqual([]);

    const wrong = await fetch(`${base}/settings/issuer/logo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'image/png',
        'x-second-factor': evidenceHeader({ currentPassword: 'falsch' }),
      },
      body: png,
    });
    expect(wrong.status).toBe(401);

    const ok = await fetch(`${base}/settings/issuer/logo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'image/png',
        'x-second-factor': evidenceHeader({ currentPassword: PASSWORD }),
      },
      body: png,
    });
    expect(ok.status).toBe(200);
    expect(writes).toEqual([`logo:${png.length}`]);
  });

  it('DELETE logo: 401 ohne Nachweis, Erfolg mit Nachweis im Kopf', async () => {
    const without = await fetch(`${base}/settings/issuer/logo`, { method: 'DELETE' });
    expect(without.status).toBe(401);
    const ok = await fetch(`${base}/settings/issuer/logo`, {
      method: 'DELETE',
      headers: { 'x-second-factor': evidenceHeader({ currentPassword: PASSWORD }) },
    });
    expect(ok.status).toBe(200);
    expect(writes).toEqual(['delete']);
  });

  it('GET bleibt ohne Nachweis lesbar', async () => {
    const response = await fetch(`${base}/settings/issuer`);
    expect(response.status).toBe(200);
  });
});
