import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api-client')>()),
  fetchCsrf: async () => 'csrf-token',
}));

import { downloadGobdExport } from './api';

describe('downloadGobdExport', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('nutzt immer POST; der Nachweis steht im Body, nie in der URL', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(new Blob(['z']), {
          status: 200,
          headers: { 'content-disposition': 'attachment; filename="a.zip"' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await downloadGobdExport({ from: '2026-01-01', to: '2026-06-30' });
    await downloadGobdExport({ from: '2026-01-01', to: '2026-06-30' }, { currentPassword: 'geheim' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(init.method).toBe('POST');
      expect(url).not.toContain('?');
      expect(url).not.toContain('geheim');
    }
    const bodies = (fetchMock.mock.calls as unknown as [string, RequestInit][]).map(([, i]) =>
      JSON.parse(String(i.body)),
    );
    expect(bodies[0]).toEqual({ from: '2026-01-01', to: '2026-06-30' });
    expect(bodies[1]).toEqual({ from: '2026-01-01', to: '2026-06-30', currentPassword: 'geheim' });
  });
});
