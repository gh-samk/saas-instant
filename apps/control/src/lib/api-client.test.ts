import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './api-client';

/**
 * [K1] Der leere Antwortkörper.
 *
 * `GET :id/instanz` antwortet bei fehlender Instanz mit 200, `Content-Length: 0`
 * und ohne `Content-Type` — live nachgemessen. Machte `apiFetch` daraus
 * `undefined`, rutschte der Wert an jeder `=== null`-Prüfung der Oberfläche
 * vorbei. Eine Karte stürzte ab und riss die ganze Seite mit.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[K1] apiFetch bei leerem Körper', () => {
  it('liefert null, nicht undefined', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 200 })),
    );
    const result = await apiFetch<unknown>('/api/irgendwas');
    expect(result).toBeNull();
    expect(result).not.toBeUndefined();
  });

  it('liefert null auch bei 204 ohne Körper', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    expect(await apiFetch<unknown>('/api/irgendwas')).toBeNull();
  });

  it('lässt echtes JSON unangetastet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ a: 1 }), { status: 200 })),
    );
    expect(await apiFetch<{ a: number }>('/api/irgendwas')).toEqual({ a: 1 });
  });

  it('unterscheidet den leeren Körper weiterhin von einem Fehler', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: 'weg', message: 'Weg.' } }),
            { status: 404 },
          ),
      ),
    );
    await expect(apiFetch<unknown>('/api/irgendwas')).rejects.toThrow('Weg.');
  });
});
