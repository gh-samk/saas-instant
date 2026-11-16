import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { PortalLoginPage } from './PortalLoginPage';
import { NoAccessPage } from './NoAccessPage';
import { StepUpDonePage } from './StepUpDonePage';

const replace = vi.fn();
const close = vi.fn();

beforeEach(() => {
  replace.mockReset();
  close.mockReset();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, replace, origin: 'http://localhost' },
  });
  window.close = close;
});

afterEach(() => vi.restoreAllMocks());

describe('PortalLoginPage', () => {
  it('leitet ohne Sitzung automatisch zum Portal, mit Rücksprungpfad', () => {
    render(
      <MemoryRouter>
        <PortalLoginPage failed={false} returnPath="/invoices/1" />
      </MemoryRouter>,
    );
    expect(replace).toHaveBeenCalledWith('/api/auth/sso/start?return=%2Finvoices%2F1');
    expect(screen.getByRole('button', { name: 'Mit dem Portal anmelden' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Notzugang' })).toHaveAttribute(
      'href',
      '/login?notfall=1',
    );
  });

  it('leitet nach einem Fehlschlag NICHT weiter (keine Schleife) und zeigt den Fehler', () => {
    render(
      <MemoryRouter>
        <PortalLoginPage failed returnPath="/" />
      </MemoryRouter>,
    );
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Anmeldung fehlgeschlagen');
    expect(screen.getByRole('button', { name: 'Erneut mit dem Portal anmelden' })).toBeInTheDocument();
  });
});

describe('NoAccessPage', () => {
  it('zeigt „Kein Zugriff auf diese Verwaltung"', () => {
    render(
      <MemoryRouter>
        <NoAccessPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('Kein Zugriff auf diese Verwaltung')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('keine Rolle');
  });
});

describe('StepUpDonePage', () => {
  it('meldet das Ergebnis über den BroadcastChannel und schließt das Fenster', async () => {
    const received: unknown[] = [];
    const listener = new BroadcastChannel('si-step-up');
    listener.onmessage = (event) => received.push(event.data);
    render(
      <MemoryRouter initialEntries={['/step-up-done']}>
        <Routes>
          <Route path="/step-up-done" element={<StepUpDonePage />} />
        </Routes>
      </MemoryRouter>,
    );
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({ type: 'si-step-up', ok: true });
    expect(close).toHaveBeenCalled();
    listener.close();
  });

  it('meldet einen Misserfolg (sso=failed)', async () => {
    const received: unknown[] = [];
    const listener = new BroadcastChannel('si-step-up');
    listener.onmessage = (event) => received.push(event.data);
    render(
      <MemoryRouter initialEntries={['/step-up-done?sso=failed']}>
        <Routes>
          <Route path="/step-up-done" element={<StepUpDonePage />} />
        </Routes>
      </MemoryRouter>,
    );
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({ type: 'si-step-up', ok: false });
    listener.close();
  });

  it('meldet unter StrictMode (doppelter Effekt) nur einmal', async () => {
    const received: unknown[] = [];
    const listener = new BroadcastChannel('si-step-up');
    listener.onmessage = (event) => received.push(event.data);
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/step-up-done']}>
          <Routes>
            <Route path="/step-up-done" element={<StepUpDonePage />} />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    );
    await vi.waitFor(() => expect(received).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toHaveLength(1);
    listener.close();
  });
});
