import 'reflect-metadata';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Controller, Get, Post, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AppController, RobotsController } from '../app.controller';
import { AccessController } from '../auth/access.controller';
import { AuthController } from '../auth/auth.controller';
import { FlagPublicController } from '../feature-flags/flag-public.controller';
import { BackupController } from '../instances/backup.controller';
import { InternalBackupPlanController } from '../instances/internal-backup-plan.controller';
import { PublicConfigController } from '../manifest/public-config.controller';
import { ConsentPublicController } from '../consent/consent-public.controller';
import { PublicController } from '../public/public.controller';
import { CompanyController } from '../companies/company.controller';
import { SsoController } from '../sso/sso.controller';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import {
  AllowWhileLocked,
  ALLOW_WHILE_LOCKED,
  ALLOW_WHILE_UNINITIALIZED,
} from './allow-while-locked.decorator';
import { VaultLockGuard } from './vault-lock.guard';
import { VaultController, VaultStatusController } from './vault.controller';
import { VaultService } from './vault.service';

@Controller('companies')
class ProbeCompanies {
  @Get()
  list(): { secret: true } {
    return { secret: true };
  }
}

@Controller('open')
class ProbeOpen {
  @AllowWhileLocked('Test: liest keine verschlüsselten Felder.')
  @Get()
  list(): { open: true } {
    return { open: true };
  }

  @Post()
  write(): { written: true } {
    return { written: true };
  }
}

/** Schickt die Anfrage mit frei wählbarer Anfrage-Zeile (auch absolute URL). */
function raw(port: number, method: string, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: target, method },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('VaultLockGuard (echte Nest-Anwendung, Express-Routing)', () => {
  let app: INestApplication;
  let port: number;
  let ready = false;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeCompanies, ProbeOpen],
      providers: [
        { provide: VaultService, useValue: { isReady: () => ready, state: async () => 'locked' } },
        { provide: APP_GUARD, useClass: VaultLockGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    ready = false;
  });

  it.each([
    ['/api/companies'],
    // Express ordnet diese Schreibweisen derselben Route zu; ein Pfadvergleich
    // im Guard sah sie früher als "außerhalb von /api" und ließ sie durch.
    ['/API/companies'],
    ['/Api/Companies'],
    ['/api/companies/'],
    ['/api/companies?x=1'],
    ['http://example.test/api/companies'],
    ['http://example.test/API/companies'],
  ])('gesperrt: GET %s -> 423 vault_locked', async (target) => {
    const res = await raw(port, 'GET', target);
    expect(res.status).toBe(423);
    expect(res.body).toContain('vault_locked');
    expect(res.body).not.toContain('secret');
  });

  it.each([['/api/open'], ['/API/open'], ['http://example.test/api/open']])(
    'gesperrt: markierter Handler GET %s -> 200',
    async (target) => {
      const res = await raw(port, 'GET', target);
      expect(res.status).toBe(200);
    },
  );

  it('die Markierung gilt nur für den Handler, nicht für die Schwesterroute (POST /api/open)', async () => {
    expect((await raw(port, 'POST', '/api/open')).status).toBe(423);
  });

  it('entsperrt und bereit: alles läuft durch', async () => {
    ready = true;
    expect((await raw(port, 'GET', '/API/companies')).status).toBe(200);
  });
});

describe('Ausnahmen von der Tresor-Sperre (Bestandsliste)', () => {
  const reason = (target: object | ((...a: never[]) => unknown)): unknown =>
    Reflect.getMetadata(ALLOW_WHILE_LOCKED, target);

  it.each([
    ['AppController.health', AppController.prototype.health],
    ['AppController.version', AppController.prototype.version],
    ['VaultStatusController.status', VaultStatusController.prototype.status],
    ['VaultController.unlock', VaultController.prototype.unlock],
    ['VaultController.setup', VaultController.prototype.setup],
    ['InternalBackupPlanController.get', InternalBackupPlanController.prototype.get],
    ['BackupController.report', BackupController.prototype.report],
    ['FlagPublicController.state', FlagPublicController.prototype.state],
    ['ConsentPublicController.unsubscribeClick', ConsentPublicController.prototype.unsubscribeClick],
    ['ConsentPublicController.unsubscribeOneClick', ConsentPublicController.prototype.unsubscribeOneClick],
  ])('%s ist mit Begründung markiert', (_name, handler) => {
    expect(typeof reason(handler)).toBe('string');
    expect((reason(handler) as string).length).toBeGreaterThan(20);
  });

  it.each([
    ['RobotsController', RobotsController],
    ['PublicConfigController', PublicConfigController],
  ])('%s ist als Ganzes markiert', (_name, controller) => {
    expect(typeof reason(controller)).toBe('string');
  });

  /** Namen aller Routen-Methoden eines Controllers. */
  const handlers = (controller: { prototype: object }): string[] =>
    Object.getOwnPropertyNames(controller.prototype).filter(
      (n) =>
        n !== 'constructor' &&
        Reflect.hasMetadata(
          PATH_METADATA,
          (controller.prototype as unknown as Record<string, object>)[n],
        ),
    );

  it.each([
    ['AuthController', AuthController],
    ['SsoController', SsoController],
  ])('%s: nicht klassenweit, aber jeder Handler (Anmeldung/Sitzung) begründet markiert', (_n, controller) => {
    expect(reason(controller)).toBeUndefined();
    const names = handlers(controller);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const r = reason((controller.prototype as unknown as Record<string, object>)[name]);
      expect(typeof r).toBe('string');
      expect((r as string).length).toBeGreaterThan(20);
    }
  });

  it('AccessController: Kontopflege bleibt gesperrt, nur die Ersteinrichtung ist (ohne Tresor) erreichbar', () => {
    const proto = AccessController.prototype as unknown as Record<string, object>;
    expect(reason(AccessController)).toBeUndefined();
    const names = handlers(AccessController);
    for (const name of names) expect(reason(proto[name])).toBeUndefined();
    const onlyFirst = names.filter((n) =>
      Reflect.getMetadata(ALLOW_WHILE_UNINITIALIZED, proto[n]),
    );
    expect(onlyFirst.sort()).toEqual(
      [
        'passkeyStart',
        'passkeyComplete',
        'passwordSet',
        'totpSetup',
        'totpConfirm',
        'emailCodeSetup',
        'emailCodeConfirm',
        'recoveryCodes',
      ].sort(),
    );
    for (const n of ['factors', 'factorRemove', 'outbox', 'devices', 'deviceRevoked', 'signOutAll']) {
      expect(names).toContain(n);
      expect(onlyFirst).not.toContain(n);
    }
  });

  it.each([
    ['VaultController.addPassphrase', VaultController.prototype.addPassphrase],
    ['VaultController.entries', VaultController.prototype.entries],
    ['ConsentPublicController.confirmation', ConsentPublicController.prototype.confirmation],
    ['ConsentPublicController.confirmationPage', ConsentPublicController.prototype.confirmationPage],
    ['PublicController (Anfrage)', PublicController],
    ['CompanyController', CompanyController],
  ])('%s bleibt gesperrt', (_name, target) => {
    expect(reason(target as object)).toBeUndefined();
  });
});

describe('VaultLockGuard mit den echten Controllern', () => {
  type VaultMock = { isReady: () => boolean; state: () => Promise<string> };
  const run = (
    vault: VaultMock,
    controller: { prototype: object },
    method: string,
  ): Promise<boolean> => {
    const guard = new VaultLockGuard(vault as unknown as VaultService, new Reflector());
    const ctx = {
      getType: () => 'http',
      getClass: () => controller,
      getHandler: () => (controller.prototype as Record<string, unknown>)[method],
    };
    return guard.canActivate(ctx as never) as Promise<boolean>;
  };
  const locked: VaultMock = { isReady: () => false, state: async () => 'locked' };
  const fresh: VaultMock = { isReady: () => false, state: async () => 'uninitialized' };

  it('gesperrt: POST /api/access/password (Passwort ändern) -> 423, Anmeldung geht weiter', async () => {
    await expect(run(locked, AccessController, 'passwordSet')).rejects.toMatchObject({ status: 423 });
    await expect(run(locked, AccessController, 'totpSetup')).rejects.toMatchObject({ status: 423 });
    await expect(run(locked, AccessController, 'factorRemove')).rejects.toMatchObject({ status: 423 });
    await expect(run(locked, AccessController, 'signOutAll')).rejects.toMatchObject({ status: 423 });
    for (const m of ['login', 'me', 'logout', 'csrf', 'secondFactorTotp']) {
      await expect(run(locked, AuthController, m)).resolves.toBe(true);
    }
    for (const m of ['start', 'callback', 'frontChannelLogout']) {
      await expect(run(locked, SsoController, m)).resolves.toBe(true);
    }
  });

  it('frische Installation (kein Tresor): Ersteinrichtung des Kontos geht, Kontopflege nicht', async () => {
    await expect(run(fresh, AccessController, 'passwordSet')).resolves.toBe(true);
    await expect(run(fresh, AccessController, 'totpSetup')).resolves.toBe(true);
    await expect(run(fresh, AccessController, 'signOutAll')).rejects.toMatchObject({ status: 423 });
  });

  it('Datenbankfehler beim Tresorzustand: Ersteinrichtung wird nicht durchgelassen (fail-closed)', async () => {
    const broken: VaultMock = {
      isReady: () => false,
      state: async () => {
        throw new Error('db down');
      },
    };
    await expect(run(broken, AccessController, 'passwordSet')).rejects.toThrow('db down');
  });
});
