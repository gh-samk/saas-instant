import type { ExecutionContext } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { VaultLockGuard, isAllowedWhileLocked } from './vault-lock.guard';
import type { VaultService } from './vault.service';

function contextFor(method: string, url: string): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ method, originalUrl: url, url }) }),
  } as unknown as ExecutionContext;
}

const vaultReady = (ready: boolean) => ({ isReady: () => ready }) as unknown as VaultService;

describe('VaultLockGuard', () => {
  describe('gesperrt: nur die Ausnahmen sind erreichbar', () => {
    it.each([
      ['GET', '/api/health'],
      ['GET', '/api/version'],
      ['GET', '/api/public-config'],
      ['GET', '/api/public/logo'],
      ['GET', '/api/auth/csrf'],
      ['GET', '/api/auth/me'],
      ['POST', '/api/auth/login'],
      ['POST', '/api/auth/login/totp'],
      ['POST', '/api/auth/logout'],
      ['POST', '/api/auth/passkey/login/start'],
      ['GET', '/api/access/factors'],
      ['POST', '/api/access/totp/confirm'],
      ['GET', '/api/vault/status'],
      ['POST', '/api/vault/unlock'],
      ['POST', '/api/vault/setup'],
      ['GET', '/robots.txt'],
      ['GET', '/api/health?x=1'],
    ])('%s %s -> erlaubt', (method, url) => {
      expect(isAllowedWhileLocked(method, url)).toBe(true);
    });

    it.each([
      ['GET', '/api/companies'],
      ['GET', '/api/companies/abc'],
      ['POST', '/api/public/inquiry'],
      ['POST', '/api/public/anfrage'],
      ['POST', '/api/consent/subscribe'],
      ['GET', '/api/tasks'],
      ['GET', '/api/invoices'],
      ['GET', '/api/audit'],
      ['GET', '/api/users'],
      ['GET', '/api/vault/entries'],
      ['POST', '/api/vault/passphrases'],
      ['PUT', '/api/vault/passphrases/x'],
      ['POST', '/api/vault/recovery'],
      ['GET', '/api/vault/unlock'],
      ['POST', '/api/vault/status'],
      ['POST', '/api/health'],
      ['POST', '/api/public/logo'],
      ['GET', '/api/internal/backup-plan'],
      ['GET', '/api/internal/invoice-archive'],
      ['GET', '/api/authx'],
      ['GET', '/api/vaultx/status'],
      ['GET', '/api'],
    ])('%s %s -> 423', (method, url) => {
      expect(isAllowedWhileLocked(method, url)).toBe(false);
    });
  });

  it('antwortet bei gesperrtem Tresor 423 mit dem Fehlercode vault_locked', () => {
    const guard = new VaultLockGuard(vaultReady(false));
    let caught: unknown;
    try {
      guard.canActivate(contextFor('GET', '/api/companies'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(423);
    expect((caught as HttpException).getResponse()).toMatchObject({
      errorCode: 'vault_locked',
    });
  });

  it('lässt Ausnahmen bei gesperrtem Tresor durch', () => {
    const guard = new VaultLockGuard(vaultReady(false));
    expect(guard.canActivate(contextFor('POST', '/api/vault/unlock'))).toBe(true);
    expect(guard.canActivate(contextFor('GET', '/api/health'))).toBe(true);
  });

  it('lässt bei entsperrtem Tresor alles durch', () => {
    const guard = new VaultLockGuard(vaultReady(true));
    expect(guard.canActivate(contextFor('GET', '/api/companies'))).toBe(true);
  });
});
