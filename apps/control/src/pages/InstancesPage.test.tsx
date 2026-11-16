import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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
  company: { id: COMPANY_ID, name: 'Beispiel e. V. mit einem sehr langen Namen, der nicht abgeschnitten werden darf' },
  appVersion: '1.4.2',
  activePersons: 12,
  lastBackupAt: '2026-09-14',
  backupMissing: false,
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
    expect(table.getByText(/^Beispiel e\. V\. mit einem sehr langen Namen/)).toBeInTheDocument();
    expect(table.getByText('1.4.2')).toBeInTheDocument();
    expect(table.getByText('12')).toBeInTheDocument();
    expect(table.getByText('14.09.2026')).toBeInTheDocument();
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

  it('zeigt bei überfälliger Sicherung einen Warnpunkt mit Wort und filtert „Nur mit Problemen"', async () => {
    const late = {
      ...ENTRY,
      id: 'i2',
      subdomain: 'spaet',
      lastBackupAt: '2026-09-01',
      backupMissing: true,
      company: { id: 'c2', name: 'Spät e. V.' },
    };
    mockFetch((path) =>
      path.includes('/api/instances')
        ? new Response(JSON.stringify([ENTRY, late]), { status: 200 })
        : new Response('{}', { status: 200 }),
    );
    window.history.pushState({}, '', '/instances');
    renderWithI18n(<App />);

    await screen.findByText('spaet');
    expect(within(screen.getByRole('table')).getByText('überfällig')).toBeInTheDocument();
    expect(screen.getByText('beispiel')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Nur mit Problemen/ }));
    expect(screen.queryByText('beispiel')).toBeNull();
    expect(screen.getByText('spaet')).toBeInTheDocument();
  });

  it('wählt bei „+ Instanz" die Organisation und öffnet in ihr den Anlegen-Dialog', async () => {
    mockFetch((path) => {
      if (path.includes('/api/instances')) {
        return new Response(JSON.stringify([ENTRY]), { status: 200 });
      }
      if (path.includes('/api/companies?') || path.endsWith('/api/companies')) {
        return new Response(
          JSON.stringify({
            companies: [{ id: COMPANY_ID, name: 'Neue Orga', city: 'Bonn' }],
            total: 1,
            page: 1,
            perPage: 8,
            countPerStatus: {},
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    });
    window.history.pushState({}, '', '/instances');
    renderWithI18n(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /\+?\s*Instanz$/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Neue Orga/ }));

    await waitFor(() => {
      expect(window.location.pathname).toBe(`/companies/${COMPANY_ID}`);
    });
    expect(window.location.search).toContain('tab=instance');
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

/** Schmaler Bildschirm: `matchMedia` meldet „passt nicht" für jede Mindestbreite. */
function stubNarrow() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

describe('Instanzliste — Karten unter 1280 px', () => {
  it('zeigt statt der Tabelle Karten, die in den Reiter „Instanz" führen', async () => {
    stubNarrow();
    mockFetch((path) =>
      path.includes('/api/instances')
        ? new Response(JSON.stringify([ENTRY]), { status: 200 })
        : new Response('{}', { status: 200 }),
    );
    window.history.pushState({}, '', '/instances');
    renderWithI18n(<App />);

    const cards = await screen.findByRole('list', { name: 'Instanzen' });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const card = within(cards).getByRole('listitem');
    expect(within(card).getByRole('link', { name: 'beispiel' })).toHaveAttribute(
      'href',
      `/companies/${COMPANY_ID}?tab=instance`,
    );
    expect(card).toHaveTextContent('Aktiv');
    expect(card).toHaveTextContent('Beispiel e. V. mit einem sehr langen Namen');
    expect(card).toHaveTextContent('1.4.2');
    expect(card).toHaveTextContent('14.09.2026');
    expect(card).toHaveTextContent('12.09.2026');
  });
});
