import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import App from '../App';
import { renderWithI18n } from '../test-support/render-with-i18n';

const STATE = {
  user: {
    id: 'b1',
    name: 'Testbetreiberin',
    username: 'test',
    email: 'test@example.com',
    role: 'owner',
  },
  passwordSet: true,
  passkeyCount: 0,
  totpConfigured: true,
  emailCodeConfigured: true,
  loginCodeEmail: 'test@example.com',
  setUpFactors: ['totp'],
  openRecoveryCodes: 8,
};

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';

const ENTRY = {
  id: 'i1',
  subdomain: 'beispiel',
  url: 'https://beispiel.example.com',
  status: 'active',
  createdAt: '2026-09-12T08:48:13.000Z',
  company: { id: COMPANY_ID, name: 'Beispiel e. V.' },
};

function mockFetch(respond: (path: string) => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes('/api/auth/csrf')) {
        return new Response(JSON.stringify({ csrfToken: 'abc' }), { status: 200 });
      }
      if (path.includes('/api/auth/me')) {
        return new Response(JSON.stringify(STATE), { status: 200 });
      }
      return respond(path);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('Instanzliste', () => {
  it('zeigt Subdomain, Host, Status, Organisation und Datum in deutscher Form', async () => {
    mockFetch((path) =>
      path.includes('/api/instances')
        ? new Response(JSON.stringify([ENTRY]), { status: 200 })
        : new Response('{}', { status: 200 }),
    );
    window.history.pushState({}, '', '/instances');
    renderWithI18n(<App />);

    await screen.findByText('beispiel');
    const table = within(screen.getByRole('table'));
    expect(table.getByText('beispiel.example.com')).toBeInTheDocument();
    expect(table.getByText('Aktiv')).toBeInTheDocument();
    expect(table.getByText('Beispiel e. V.')).toBeInTheDocument();
    expect(table.getByText('12.09.2026')).toBeInTheDocument();
  });

  it('führt jede Zeile direkt in den Reiter „Instanz" ihrer Organisation', async () => {
    mockFetch((path) =>
      path.includes('/api/instances')
        ? new Response(JSON.stringify([ENTRY]), { status: 200 })
        : new Response('{}', { status: 200 }),
    );
    window.history.pushState({}, '', '/instances');
    renderWithI18n(<App />);

    const link = await screen.findByRole('link', { name: 'beispiel' });
    expect(link).toHaveAttribute('href', `/companies/${COMPANY_ID}?tab=instance`);
  });

  it('sagt, wo eine Instanz angelegt wird, solange es keine gibt', async () => {
    mockFetch((path) =>
      path.includes('/api/instances')
        ? new Response('[]', { status: 200 })
        : new Response('{}', { status: 200 }),
    );
    window.history.pushState({}, '', '/instances');
    renderWithI18n(<App />);

    expect(await screen.findByText('Noch keine Instanzen')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('meldet einen Ladefehler und bietet einen zweiten Versuch an', async () => {
    mockFetch((path) =>
      path.includes('/api/instances')
        ? new Response(JSON.stringify({ message: 'kaputt' }), { status: 500 })
        : new Response('{}', { status: 200 }),
    );
    window.history.pushState({}, '', '/instances');
    renderWithI18n(<App />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeInTheDocument();
  });
});
