import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@saas-instant/ui';
import { TaskAction } from './TaskAction';

const CHECK = {
  kind: 'outbox_check' as const,
  label: 'Jetzt erneut prüfen',
  target: '',
};

function situation(state: string) {
  return [
    {
      role: 'admin',
      state,
      checkedAt: '2026-09-12T10:00:00.000Z',
      disruptedSince: null,
      errorClass: null,
      detectedBy: null,
    },
  ];
}

function arrangeFetch(response: () => Response) {
  const called = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    if (String(input).includes('/api/auth/csrf')) {
      return new Response(JSON.stringify({ csrfToken: 'abc' }), { status: 200 });
    }
    return response();
  });
  vi.stubGlobal('fetch', called);
  return called;
}

function show(afterAction = vi.fn()) {
  render(
    <MemoryRouter>
      <ToastProvider>
        <TaskAction action={CHECK} afterAction={afterAction} />
      </ToastProvider>
    </MemoryRouter>,
  );
  return afterAction;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AufgabenAktion — Postausgang prüfen', () => {
  it('ist ein Knopf, kein Link', () => {
    arrangeFetch(() => new Response('[]', { status: 200 }));
    show();
    expect(screen.getByRole('button', { name: /Jetzt erneut prüfen/ })).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('prüft per POST, meldet das Ergebnis und lädt die Aufgaben neu', async () => {
    const called = arrangeFetch(
      () => new Response(JSON.stringify(situation('in_ordnung')), { status: 200 }),
    );
    const afterAction = show();

    fireEvent.click(screen.getByRole('button', { name: /Jetzt erneut prüfen/ }));

    expect(await screen.findByText('Der Postausgang arbeitet wieder.')).toBeInTheDocument();
    await waitFor(() => expect(afterAction).toHaveBeenCalledTimes(1));
    const probe = called.mock.calls.find(([url]) =>
      String(url).includes('/api/outbox/check'),
    );
    expect(probe?.[1]?.method).toBe('POST');
  });

  it('sagt es, wenn der Postausgang weiterhin gestört ist', async () => {
    arrangeFetch(() => new Response(JSON.stringify(situation('gestoert')), { status: 200 }));
    show();

    fireEvent.click(screen.getByRole('button', { name: /Jetzt erneut prüfen/ }));

    expect(
      await screen.findByText('Der Postausgang ist weiterhin gestört.'),
    ).toBeInTheDocument();
  });
});
