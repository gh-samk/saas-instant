import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadIssuerLogo } from './api';

/**
 * Der Server liest den Logo-Upload roh und prüft die Bildsignatur. Ein
 * Multipart-Formular würde dort immer abgelehnt — also muss die Datei selbst
 * mit ihrem eigenen Typ auf die Leitung.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uploadIssuerLogo', () => {
  it('schickt die Datei roh mit ihrem Typ, nicht als Formular', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', {
      type: 'image/png',
    });

    await uploadIssuerLogo(png);

    // Vor dem POST holt der Client ggf. erst das CSRF-Token; gezählt wird nur der Upload.
    const upload = fetchMock.mock.calls.filter(([u]) => u.endsWith('/api/settings/issuer/logo'));
    expect(upload).toHaveLength(1);
    const [, init] = upload[0]!;
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(png);
    expect(init?.body).not.toBeInstanceOf(FormData);
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('image/png');
  });
});
