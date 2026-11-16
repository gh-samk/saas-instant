import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { apiFetch } from '../lib/api-client';
import { VaultProvider } from '../context/VaultContext';
import { VaultGate } from './VaultGate';

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    reload: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn(),
    state: { totpSetUp: false, user: { id: 'u1' } },
  }),
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/** Eine „Seite", die beim Laden Daten holt — wie jede echte Seite hinter dem Tor. */
function Page() {
  const [text, setText] = useState('lädt');
  useEffect(() => {
    apiFetch<{ name: string }>('/api/companies').then(
      (r) => setText(r.name),
      () => setText('Fehler'),
    );
  }, []);
  return <p>Seite: {text}</p>;
}

function arrange(options: { status: string; companiesLocked?: boolean }) {
  let locked = options.companiesLocked ?? false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.includes('/api/auth/csrf')) return json({ csrfToken: 'abc' });
    if (path.includes('/api/vault/status')) return json({ state: options.status });
    if (path.includes('/api/vault/unlock')) {
      locked = false;
      expect(init?.method).toBe('POST');
      return json({ state: 'unlocked' });
    }
    if (path.includes('/api/companies')) {
      return locked
        ? json({ error: { code: 'vault_locked', message: 'gesperrt' } }, 423)
        : json({ name: 'Beispiel GmbH' });
    }
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderGate() {
  return render(
    <VaultProvider>
      <VaultGate>
        <Page />
      </VaultGate>
    </VaultProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('VaultGate', () => {
  it('lässt bei entsperrter Verwaltung die Seite durch', async () => {
    arrange({ status: 'unlocked' });
    renderGate();
    expect(await screen.findByText('Seite: Beispiel GmbH')).toBeInTheDocument();
  });

  it('zeigt bei gesperrtem Zustand die Entsperrseite statt der Seite', async () => {
    arrange({ status: 'locked' });
    renderGate();
    expect(await screen.findByRole('heading', { name: 'Verwaltung entsperren' })).toBeInTheDocument();
    expect(screen.queryByText(/Seite:/)).toBeNull();
  });

  it('zeigt bei fehlender Einrichtung den Assistenten', async () => {
    arrange({ status: 'uninitialized' });
    renderGate();
    expect(await screen.findByRole('heading', { name: 'Daten verschlüsseln' })).toBeInTheDocument();
  });

  it('sperrt nicht aus, wenn der Zustand nicht lesbar ist', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('Netz');
    }));
    renderGate();
    expect(await screen.findByText(/Seite:/)).toBeInTheDocument();
  });

  it('leitet eine 423-Antwort auf die Entsperrseite und danach zurück auf dieselbe Seite', async () => {
    window.history.pushState({}, '', '/companies/42');
    arrange({ status: 'unlocked', companiesLocked: true });
    renderGate();

    // Die Seite war da, ihre erste Anfrage trifft auf 423 → Entsperrseite.
    expect(await screen.findByRole('heading', { name: 'Verwaltung entsperren' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/companies/42');

    fireEvent.change(screen.getByLabelText('Passphrase'), {
      target: { value: 'ein langer sicherer satz' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Entsperren' }));

    // Nach dem Entsperren steht dieselbe Adresse wieder da, die Seite lädt neu.
    await waitFor(() => expect(screen.getByText('Seite: Beispiel GmbH')).toBeInTheDocument());
    expect(window.location.pathname).toBe('/companies/42');
  });
});
