import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, apiFile, setVaultLockedHandler } from './api-client';

/**
 * 423 „Verwaltung gesperrt": Jede Anfrage, die auf die Sperre stößt, meldet es
 * dem globalen Handler. Der Fehler selbst wird trotzdem weitergereicht.
 */

const LOCKED = JSON.stringify({
  error: { code: 'vault_locked', message: 'Die Verwaltung ist gesperrt.' },
});

afterEach(() => {
  setVaultLockedHandler(null);
  vi.unstubAllGlobals();
});

describe('globaler 423-Handler', () => {
  it('ruft den Handler bei 423 und wirft weiter den Fehler', async () => {
    const handler = vi.fn();
    setVaultLockedHandler(handler);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(LOCKED, { status: 423 })));

    const error = await apiFetch('/api/companies').catch((e: unknown) => e);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(423);
    expect((error as ApiError).error.code).toBe('vault_locked');
  });

  it('ruft ihn auch bei Dateidownloads', async () => {
    const handler = vi.fn();
    setVaultLockedHandler(handler);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(LOCKED, { status: 423 })));

    await expect(apiFile('/api/invoices/1/pdf')).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('ruft ihn bei anderen Fehlern nicht', async () => {
    const handler = vi.fn();
    setVaultLockedHandler(handler);
    for (const status of [400, 401, 403, 404, 500]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })));
      await apiFetch('/api/x').catch(() => undefined);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('bleibt ohne Handler stumm', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(LOCKED, { status: 423 })));
    await expect(apiFetch('/api/companies')).rejects.toBeInstanceOf(ApiError);
  });
});
