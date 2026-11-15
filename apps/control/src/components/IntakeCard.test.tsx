import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { ToastProvider } from '@saas-instant/ui';
import { AuthProvider } from '../context/AuthContext';
import { IntakeCard } from './IntakeCard';
import type { IntakeAccessState } from '../lib/api';

/**
 * Die Aufnahmekarte — geprüft an dem, was fachlich trägt.
 *
 * Im Mittelpunkt stehen die zwei Schwellen: „Erneut senden" darf OHNE zweiten
 * Faktor gehen, „Link anzeigen" nicht. Und der Klartext-Link darf nicht schon
 * beim Laden der Karte über die Leitung kommen — das ist eine ABWESENHEIT und
 * wird als solche geprüft, nicht als Absichtserklärung.
 */

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';

const OPEN: IntakeAccessState = {
  present: true,
  expiresAt: '2026-09-21T09:00:00.000Z',
  redeemedAt: null,
  lastSentAt: '2026-09-07T09:00:00.000Z',
  sendCount: 1,
  expired: false,
  address: 'vorstand@example.com',
  completedAt: null,
  missing: [],
};

interface Options {
  state?: Partial<IntakeAccessState>;
  /** Antwortet `/aufnahmelink/anzeigen` erst nach dem Nachweis? */
  showNeedsEvidence?: boolean;
  sendReason?: 'no_address' | 'send_failed';
}

function arrangeFetch(options: Options = {}) {
  const called = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (path.includes('/api/auth/csrf')) {
      return new Response(JSON.stringify({ csrfToken: 'abc' }), { status: 200 });
    }
    if (path.endsWith('/intake-access')) {
      return new Response(JSON.stringify({ ...OPEN, ...options.state }), {
        status: 200,
      });
    }
    if (path.endsWith('/intake-link/send') && method === 'POST') {
      return new Response(
        JSON.stringify(
          options.sendReason
            ? { sent: false, email: '', reason: options.sendReason }
            : { sent: true, email: OPEN.address },
        ),
        { status: 200 },
      );
    }
    if (path.endsWith('/intake-link/reveal') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        currentPassword?: string;
      };
      if (options.showNeedsEvidence && body.currentPassword === undefined) {
        return new Response(
          JSON.stringify({
            // Genau der Code, den der `ZweitfaktorGuard` liefert — ein
            // erfundener liefe an `nachweisVerlangt()` vorbei und der Test
            // prüfte dann nichts.
            error: {
              code: 'login_failed',
              message: 'Bitte weise dich aus.',
            },
          }),
          { status: 401 },
        );
      }
      return new Response(
        JSON.stringify({
          link: 'https://verwaltung.example/api/intake/GEHEIM',
          expiresAt: '2026-09-21T09:00:00.000Z',
        }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', called);
  return called;
}

function draw() {
  // `AuthProvider`, weil `useZweitfaktorNachweis` eine tote Sitzung nachladen
  // muss — ohne ihn gäbe es den Weg zurück zur Anmeldung nicht.
  return render(
    <AuthProvider>
      <ToastProvider>
        <IntakeCard companyId={COMPANY_ID} totpPossible={false} />
      </ToastProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AufnahmeKarte', () => {
  it('nennt Frist und letzten Versand', async () => {
    arrangeFetch();
    draw();

    expect(await screen.findByText(/Noch nicht ausgefüllt/)).toBeInTheDocument();
    expect(screen.getByText(/gültig bis 21\.09\.2026/)).toBeInTheDocument();
    expect(
      screen.getByText(/Zuletzt gesendet am 07\.09\.2026 an vorstand@example\.com/),
    ).toBeInTheDocument();
  });

  it('zählt mehrfachen Versand mit', async () => {
    arrangeFetch({ state: { sendCount: 3 } });
    draw();

    expect(await screen.findByText(/3× gesendet/)).toBeInTheDocument();
  });

  it('holt den Klartext-Link NICHT beim Laden der Karte', async () => {
    const called = arrangeFetch();
    draw();

    await screen.findByText(/Noch nicht ausgefüllt/);
    const paths = called.mock.calls.map(([e]) => String(e));
    expect(paths.some((p) => p.includes('/intake-link/reveal'))).toBe(false);
    expect(screen.queryByText(/api\/aufnahme\//)).not.toBeInTheDocument();
  });

  it('sendet erneut OHNE zweiten Faktor', async () => {
    const called = arrangeFetch();
    draw();

    fireEvent.click(await screen.findByRole('button', { name: /Erneut senden/ }));

    await screen.findByText(/ist an vorstand@example\.com gegangen/);
    const show = called.mock.calls.filter(([e]) =>
      String(e).includes('/intake-link/reveal'),
    );
    expect(show).toHaveLength(0);
    // Kein Nachweis-Dialog: Der Versand darf nicht danach fragen.
    expect(screen.queryByLabelText(/Aktuelles Passwort/i)).not.toBeInTheDocument();
  });

  it('verlangt für „Link anzeigen" den Nachweis und zeigt ihn danach', async () => {
    arrangeFetch({ showNeedsEvidence: true });
    draw();

    fireEvent.click(await screen.findByRole('button', { name: 'Link anzeigen' }));

    const field = await screen.findByLabelText(/Aktuelles Passwort/i);
    fireEvent.change(field, { target: { value: 'geheim' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    await waitFor(() =>
      expect(
        screen.getByText('https://verwaltung.example/api/intake/GEHEIM'),
      ).toBeInTheDocument(),
    );
  });

  it('sperrt den Versand, solange keine Adresse hinterlegt ist', async () => {
    arrangeFetch({ state: { address: null, lastSentAt: null } });
    draw();

    expect(
      await screen.findByText(/Ohne hinterlegte E-Mail-Adresse/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Link senden/ })).toBeDisabled();
  });

  it('zeigt nach Eingang, was weiterhin fehlt', async () => {
    arrangeFetch({
      state: {
        completedAt: '2026-09-10',
        redeemedAt: '2026-09-10T08:00:00.000Z',
        missing: [{ field: 'contactPhone', label: 'Telefon der Ansprechpartnerin' }],
      },
    });
    draw();

    expect(await screen.findByText(/Ausgefüllt am 10\.09\.2026/)).toBeInTheDocument();
    expect(screen.getByText('Telefon der Ansprechpartnerin')).toBeInTheDocument();
  });
});
