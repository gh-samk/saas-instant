import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import App from '../App';
import { rememberCompany, readRecentCompanies } from '../lib/recent-companies';

/**
 * Die Kommandopalette (⌘K): Suche mit Live-Treffern, Aktionen, zuletzt
 * geöffnete Organisationen — und die Bedienung per Tastatur.
 */

const STATE = {
  user: { id: 'b1', name: 'Test', username: 'test', email: 'test@example.com', role: 'inhaber' },
  passwordSet: true,
  passkeyCount: 0,
  totpSetUp: true,
  emailCodeSetUp: true,
  loginCodeEmail: 'test@example.com',
  setUpFactors: ['totp'],
  openRecoveryCodes: 8,
};

const COMPANY = (id: string, name: string, city: string | null = null) => ({
  id,
  name,
  status: 'anfrage',
  city,
  contactName: null,
  contactEmail: null,
  reviewDueDate: null,
  lastStatusChangeAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  instanceStatus: null,
  openAmountCent: 0,
  openOverdue: false,
});

function arrange(companies = [COMPANY('c-1', 'Solawi Rheintal', 'Basel')]) {
  const called = vi.fn(async (input: unknown) => {
    const path = String(input);
    if (path.includes('/api/auth/csrf')) {
      return new Response(JSON.stringify({ csrfToken: 'abc' }), { status: 200 });
    }
    if (path.includes('/api/auth/me')) return new Response(JSON.stringify(STATE), { status: 200 });
    if (path.includes('/api/navigation/counters')) {
      return new Response(JSON.stringify({ tasksUrgent: 0, invoicesOpen: 0 }), { status: 200 });
    }
    if (/\/api\/companies\/[^/?]+$/.test(path.split('?')[0])) {
      return new Response(JSON.stringify(COMPANY('c-9', 'Hofgut Eich')), { status: 200 });
    }
    if (path.includes('/api/companies')) {
      return new Response(
        JSON.stringify({ companies, total: companies.length, page: 1, perPage: 8, countPerState: {} }),
        { status: 200 },
      );
    }
    if (path.includes('/api/tasks')) {
      return new Response(
        JSON.stringify({
          tasks: [],
          shortened: [],
          orphanedApplications: [],
          state: {
            day: '2026-09-01',
            since: '2026-08-25',
            limitPerKind: 25,
            reconciliation: { lastAt: null, successful: false, message: null },
          },
        }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', called);
  return called;
}

async function openPalette() {
  render(<App />);
  const trigger = await screen.findByRole('button', { name: 'Schnellsuche' });
  fireEvent.click(trigger);
  return {
    trigger,
    input: await screen.findByRole('combobox', { name: 'Schnellsuche' }),
  };
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* egal */
  }
  window.history.pushState({}, '', '/');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Kommandopalette', () => {
  it('öffnet mit Strg+K, trägt die Dialog- und Kombinationsfeld-Rollen und schließt mit Escape', async () => {
    arrange();
    render(<App />);
    await screen.findByRole('button', { name: 'Schnellsuche' });

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Schnellsuche und Aktionen' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const input = within(dialog).getByRole('combobox', { name: 'Schnellsuche' });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-controls', within(dialog).getByRole('listbox').id);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Schnellsuche und Aktionen' })).toBeNull();
  });

  it('öffnet mit ⌘K und gibt den Fokus an das Ausgangselement zurück', async () => {
    arrange();
    render(<App />);
    const trigger = await screen.findByRole('button', { name: 'Schnellsuche' });
    trigger.focus();

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = await screen.findByRole('combobox', { name: 'Schnellsuche' });
    fireEvent.keyDown(input, { key: 'Escape' });

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('zeigt ohne Eingabe die fünf Aktionen', async () => {
    arrange();
    await openPalette();

    const list = screen.getByRole('listbox');
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Neue Organisation',
      'Rechnung anlegen',
      'Zahlung erfassenoffene Rechnungen',
      'Heute',
      'Einstellungen',
    ]);
  });

  it('wählt mit den Pfeiltasten und meldet die Zeile über aria-activedescendant', async () => {
    arrange();
    const { input } = await openPalette();
    const options = within(screen.getByRole('listbox')).getAllByRole('option');

    expect(input).toHaveAttribute('aria-activedescendant', options[0].id);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', options[1].id);
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(options[0]).toHaveAttribute('aria-selected', 'false');

    // Am Ende geht es wieder von vorn los, nach oben ans Ende.
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveAttribute('aria-activedescendant', options[4].id);
  });

  it('führt „Einstellungen" mit Enter aus', async () => {
    arrange();
    const { input } = await openPalette();
    fireEvent.keyDown(input, { key: 'End' });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(window.location.pathname).toBe('/settings'));
    expect(screen.queryByRole('dialog', { name: 'Schnellsuche und Aktionen' })).toBeNull();
  });

  it('führt „Zahlung erfassen" zur Rechnungsliste der offenen Rechnungen', async () => {
    arrange();
    await openPalette();
    fireEvent.click(screen.getByRole('option', { name: /Zahlung erfassen/ }));

    await waitFor(() => expect(window.location.pathname).toBe('/invoices'));
    expect(window.location.search).toBe('?state=open');
  });

  it('öffnet bei „Rechnung anlegen" die Organisationswahl', async () => {
    arrange();
    await openPalette();
    fireEvent.click(screen.getByRole('option', { name: 'Rechnung anlegen' }));

    expect(await screen.findByRole('dialog', { name: /Organisation/ })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Schnellsuche' })).toBeNull();
  });

  it('öffnet bei „Neue Organisation" den Anlegen-Dialog', async () => {
    arrange();
    await openPalette();
    fireEvent.click(screen.getByRole('option', { name: 'Neue Organisation' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Schnellsuche' })).toBeNull();
  });

  it('Enter nach Eingabe sucht wie bisher in der Organisationsliste', async () => {
    arrange();
    const { input } = await openPalette();
    fireEvent.change(input, { target: { value: 'Muster GmbH' } });
    // Der „Suchen"-Eintrag steht sofort ganz oben, ohne auf Treffer zu warten.
    expect(within(screen.getByRole('listbox')).getAllByRole('option')[0]).toHaveTextContent(
      'Alle Organisationen mit „Muster GmbH" suchen',
    );
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(window.location.search).toBe('?search=Muster+GmbH'.replace('+', '%20')));
    expect(window.location.pathname).toBe('/companies');
  });

  it('zeigt Treffer nach kurzer Entprellung und öffnet die Organisation', async () => {
    const called = arrange();
    const { input } = await openPalette();
    const before = called.mock.calls.filter(([u]) => String(u).includes('search=')).length;

    fireEvent.change(input, { target: { value: 'Sol' } });
    fireEvent.change(input, { target: { value: 'Sola' } });
    // Noch kein Aufruf: Die Entprellung wartet das Ende der Eingabe ab.
    expect(called.mock.calls.filter(([u]) => String(u).includes('search=')).length).toBe(before);

    const hit = await screen.findByRole('option', { name: /Solawi Rheintal/ });
    const searches = called.mock.calls
      .map(([u]) => String(u))
      .filter((u) => u.includes('search=Sola'));
    expect(searches).toHaveLength(1);

    fireEvent.click(hit);
    await waitFor(() => expect(window.location.pathname).toBe('/companies/c-1'));
  });

  it('meldet einen Ladefehler, ohne die Suche zu blockieren', async () => {
    arrange();
    const { input } = await openPalette();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    );
    fireEvent.change(input, { target: { value: 'Fehler' } });

    expect(await screen.findByText('Die Treffer konnten nicht geladen werden.')).toBeInTheDocument();
    expect(within(screen.getByRole('listbox')).getAllByRole('option')[0]).toHaveTextContent(
      'Alle Organisationen mit',
    );
  });

  it('zeigt die zuletzt geöffneten Organisationen aus dem Speicher', async () => {
    arrange();
    rememberCompany({ id: 'c-7', name: 'Gemüsehof Aue' });
    rememberCompany({ id: 'c-8', name: 'Imkerei Berg' });
    await openPalette();

    const list = screen.getByRole('listbox');
    const group = within(list).getByRole('group', { name: 'Zuletzt geöffnet' });
    expect(within(group).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Imkerei Berg',
      'Gemüsehof Aue',
    ]);
    fireEvent.click(within(group).getByRole('option', { name: 'Gemüsehof Aue' }));
    await waitFor(() => expect(window.location.pathname).toBe('/companies/c-7'));
  });

  it('merkt sich eine geöffnete Organisation mit Namen', async () => {
    arrange();
    window.history.pushState({}, '', '/companies/c-9');
    render(<App />);
    await waitFor(() =>
      expect(readRecentCompanies()).toEqual([{ id: 'c-9', name: 'Hofgut Eich' }]),
    );
  });

  it('fängt einen gesperrten Speicher ab', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('gesperrt');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('gesperrt');
    });
    expect(readRecentCompanies()).toEqual([]);
    expect(() => rememberCompany({ id: 'x', name: 'Y' })).not.toThrow();
    spy.mockRestore();
    set.mockRestore();
  });

  it('hält den Fokus beim Tabulator im Feld', async () => {
    arrange();
    const { input } = await openPalette();
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Tab' });
    });
    expect(input).toHaveFocus();
  });
});
