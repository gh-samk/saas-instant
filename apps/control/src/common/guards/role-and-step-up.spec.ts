import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { RequireAdmin } from '../decorators/require-role.decorator';
import { WithoutSecondFactor } from '../decorators/without-second-factor.decorator';
import { ForbiddenRoleError, StepUpRequiredError } from '../errors/business-error';
import { RoleGuard } from './role.guard';
import { SecondFactorGuard } from './second-factor.guard';
import type { AccessService } from '../../auth/access.service';

class Marked {
  @RequireAdmin()
  write(): void {}
  read(): void {}
  @WithoutSecondFactor('Rein lesend, nur für diesen Test, ohne Geheimnisse.')
  free(): void {}
}

@RequireAdmin()
class WholeClass {
  anything(): void {}
}

function context(
  target: object,
  handler: string,
  request: Record<string, unknown>,
): ExecutionContext {
  const klass = (target as { constructor: new () => unknown }).constructor;
  return {
    getHandler: () => (target as Record<string, () => void>)[handler],
    getClass: () => klass,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('RoleGuard', () => {
  const guard = new RoleGuard(new Reflector());

  it('lässt ohne Markierung jeden durch', () => {
    const ctx = context(new Marked(), 'read', { user: { id: 'u' }, accessRole: 'staff' });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('lässt admin an einer markierten Route durch', () => {
    const ctx = context(new Marked(), 'write', { user: { id: 'u' }, accessRole: 'admin' });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('weist staff an einer markierten Route mit forbidden_role (403) ab', () => {
    const ctx = context(new Marked(), 'write', { user: { id: 'u' }, accessRole: 'staff' });
    let error: unknown;
    try {
      guard.canActivate(ctx);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ForbiddenRoleError);
    expect((error as ForbiddenRoleError).getStatus()).toBe(403);
    expect((error as ForbiddenRoleError).errorCode).toBe('forbidden_role');
  });

  it('weist ein Konto ohne Rollenangabe ab (im Zweifel nicht admin)', () => {
    const ctx = context(new Marked(), 'write', { user: { id: 'u' } });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenRoleError);
  });

  it('beachtet die Markierung am ganzen Controller', () => {
    const ctx = context(new WholeClass(), 'anything', {
      user: { id: 'u' },
      accessRole: 'staff',
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenRoleError);
  });

  it('bricht laut ab, wenn der SessionGuard fehlt', () => {
    const ctx = context(new Marked(), 'write', {});
    expect(() => guard.canActivate(ctx)).toThrow(/falsch verdrahtet/);
  });
});

describe('SecondFactorGuard in einer Portal-Sitzung', () => {
  const checks: unknown[][] = [];
  const access = {
    checkSecondFactor: async (...args: unknown[]) => {
      checks.push(args);
    },
  } as unknown as AccessService;
  const guard = new SecondFactorGuard(new Reflector(), access);

  beforeEach(() => {
    checks.length = 0;
  });

  it('verlangt ohne Step-up step_up_required (401) und fragt NICHT nach Passwort', async () => {
    const ctx = context(new Marked(), 'read', {
      user: { id: 'u' },
      ssoSession: { id: 's', sid: 'x', stepUpAt: null },
      body: { currentPassword: 'egal' },
    });
    const error = await guard.canActivate(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StepUpRequiredError);
    expect((error as StepUpRequiredError).getStatus()).toBe(401);
    expect((error as StepUpRequiredError).errorCode).toBe('step_up_required');
    expect(checks).toHaveLength(0);
  });

  it('akzeptiert einen Step-up von vor 4 Minuten', async () => {
    const ctx = context(new Marked(), 'read', {
      user: { id: 'u' },
      ssoSession: { id: 's', sid: 'x', stepUpAt: new Date(Date.now() - 4 * 60_000) },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(checks).toHaveLength(0);
  });

  it('verlangt einen neuen Step-up nach 6 Minuten', async () => {
    const ctx = context(new Marked(), 'read', {
      user: { id: 'u' },
      ssoSession: { id: 's', sid: 'x', stepUpAt: new Date(Date.now() - 6 * 60_000) },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(StepUpRequiredError);
  });

  it('lässt eine als frei markierte Route auch ohne Step-up durch', async () => {
    const ctx = context(new Marked(), 'free', {
      user: { id: 'u' },
      ssoSession: { id: 's', sid: 'x', stepUpAt: null },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('bleibt bei lokaler Anmeldung beim bisherigen Nachweis (Modus single)', async () => {
    const ctx = context(new Marked(), 'read', {
      user: { id: 'u' },
      ssoSession: null,
      sessionEvidenceAt: null,
      body: { currentPassword: 'pw' },
      headers: {},
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.[1]).toEqual({ currentPassword: 'pw' });
  });
});
