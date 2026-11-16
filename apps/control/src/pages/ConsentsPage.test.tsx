import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithI18n } from '../test-support/render-with-i18n';
import App from '../App';

/**
 * Der Nachweis ist der eigentliche Wert dieser Etappe — er muss sich finden
 * lassen, wenn jemand fragt.
 *
 * Geprüft wird beides: dass er vollständig dasteht (Wortlaut, beide
 * Zeitpunkte, beide IP-Adressen), und dass die Seite nichts anbietet, was es
 * nicht geben darf — keine Teilsuche, keine Gesamtliste, kein Entsperren und
 * keine Token.
 */

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
  totpSetUp: true,
  emailCodeSetUp: true,
  loginCodeEmail: 'test@example.com',
  setUpFactors: ['totp'],
  openRecoveryCodes: 8,
};

const RECIPIENT = {
  count: 1,
  recipient: [
    {
      consentId: 'e1',
      email: 'anna@example.com',
      companyId: 'o1',
      companyName: 'Verein Nord',
      confirmedAt: '2026-07-15T08:00:00.000Z',
    },
  ],
  note:
    'Stand jetzt. Massgeblich ist die Prüfung unmittelbar vor dem Versand: Wer bis dahin widerruft, bekommt nichts.',
};

const EVIDENCE = {
  consentId: 'e1',
  email: 'anna@example.com',
  status: 'confirmed',
  origin: 'website-newsletter',
  formText:
    'Ja, ich möchte die Rundmail bekommen (Neuigkeiten und Funktionsankündigungen, wenige Mails im Jahr).',
  subscribedAt: '2026-07-14T09:00:00.000Z',
  ipAtSubscription: '203.0.113.9',
  confirmedAt: '2026-07-15T08:00:00.000Z',
  ipAtConfirmation: '203.0.113.42',
  unsubscribedAt: null,
  deactivatedAt: null,
  confirmationTokenPresent: false,
  unsubscribeTokenPresent: true,
};

function setFetchReady(
  options: { evidence?: unknown; evidenceStatus?: number; empty?: boolean } = {},
) {
  const called = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/api/auth/csrf')) {
      return new Response(JSON.stringify({ csrfToken: 'abc' }), { status: 200 });
    }
    if (path.includes('/api/auth/me')) {
      return new Response(JSON.stringify(STATE), { status: 200 });
    }
    if (path.includes('/api/broadcast/evidence')) {
      return new Response(
        JSON.stringify(
          options.evidence === undefined ? EVIDENCE : options.evidence,
        ),
        { status: options.evidenceStatus ?? 200 },
      );
    }
    if (path.includes('/api/broadcast/recipients')) {
      return new Response(
        JSON.stringify(options.empty ? { ...RECIPIENT, count: 0, recipient: [] } : RECIPIENT),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', called);
  return called;
}

function open() {
  window.history.pushState({}, '', '/broadcast/consents');
  renderWithI18n(<App />);
}

async function search(address = 'anna@example.com') {
  fireEvent.change(await screen.findByLabelText('E-Mail-Adresse'), {
    target: { value: address },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Nachweis suchen' }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('Einwilligungen — der Nachweis', () => {
  it('zeigt den Formulartext im Wortlaut, beide Zeitpunkte und beide IPs', async () => {
    setFetchReady();
    open();
    await search();

    expect(
      await screen.findByText(EVIDENCE.formText),
    ).toBeInTheDocument();
    expect(screen.getByText('von 203.0.113.9')).toBeInTheDocument();
    expect(screen.getByText('von 203.0.113.42')).toBeInTheDocument();
    // Datum als dd.mm.yyyy, nie als ISO.
    expect(screen.getByText('14.07.2026')).toBeInTheDocument();
    expect(screen.getAllByText('15.07.2026').length).toBeGreaterThan(0);
    expect(screen.queryByText(/2026-07-14/)).toBeNull();
  });

  it('nennt den Zustand ausgeschrieben und erklärt, was er bedeutet', async () => {
    setFetchReady();
    open();
    await search();

    expect(await screen.findByText('Bestätigt')).toBeInTheDocument();
    expect(
      screen.getByText(/einzige Zustand, in dem eine werbliche Mail hinausgeht/),
    ).toBeInTheDocument();
  });

  it('zeigt nie einen Token, sondern nur, dass es einen gibt', async () => {
    setFetchReady();
    open();
    await search();

    await screen.findByText(EVIDENCE.formText);
    expect(screen.getByText('vorhanden')).toBeInTheDocument();
    expect(
      screen.getByText(/Wer den Abmeldetoken einer fremden Adresse liest/),
    ).toBeInTheDocument();
  });

  it('sagt bei einer unbestätigten Zeile, was dem Nachweis fehlt', async () => {
    setFetchReady({
      evidence: {
        ...EVIDENCE,
        status: 'unconfirmed',
        confirmedAt: null,
        ipAtConfirmation: null,
      },
    });
    open();
    await search();

    expect(
      await screen.findByText(/Noch nicht bestätigt/),
    ).toBeInTheDocument();
  });

  it('unterscheidet „kein Eintrag" sichtbar von einem Ladefehler', async () => {
    setFetchReady({ evidence: null });
    open();
    await search('unbekannt@example.com');

    expect(
      await screen.findByText(/gibt es keinen Eintrag/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/nach 72 Stunden vollständig gelöscht/),
    ).toBeInTheDocument();
  });

  it('zeigt den Fehler des Servers im Wortlaut, statt still zu scheitern', async () => {
    setFetchReady({
      evidenceStatus: 500,
      evidence: {
        error: {
          code: 'HTTP_500',
          message: 'Die Datenbank antwortet gerade nicht.',
        },
      },
    });
    open();
    await search();

    expect(
      await screen.findByText('Die Datenbank antwortet gerade nicht.'),
    ).toBeInTheDocument();
  });

  it('schickt eine unvollständige Adresse gar nicht erst ab', async () => {
    const called = setFetchReady();
    open();

    fireEvent.change(await screen.findByLabelText('E-Mail-Adresse'), {
      target: { value: 'anna@example' },
    });
    expect(
      screen.getByRole('button', { name: 'Nachweis suchen' }),
    ).toBeDisabled();
    await waitFor(() => {
      expect(
        called.mock.calls.filter(([path]) =>
          String(path).includes('/api/broadcast/evidence'),
        ),
      ).toHaveLength(0);
    });
  });
});

describe('Einwilligungen — was die Seite nicht anbietet', () => {
  it('kennt kein Entsperren und keine Zustandsänderung (Abwesenheit)', async () => {
    setFetchReady();
    open();

    await screen.findByLabelText('E-Mail-Adresse');
    for (const forbidden of [
      /entsperr/i,
      /aufheben/i,
      /freigeben/i,
      /bestätigen/i,
      /eintragen/i,
    ]) {
      expect(screen.queryByRole('button', { name: forbidden })).toBeNull();
    }
  });

  it('zeigt die Empfängerliste als Vorhersage und nicht als Verzeichnis', async () => {
    setFetchReady();
    open();

    expect(
      await screen.findByRole('heading', {
        name: 'Adressen mit bestätigter Einwilligung',
      }),
    ).toBeInTheDocument();
    // Seit dem Redesign steht der Satz in der Kennzahlkarte daneben, nicht
    // mehr im Hinweisblock der Liste — die Aussage bleibt dieselbe.
    expect(
      screen.getByText(
        'Vorhersage — maßgeblich ist die Prüfung vor dem Versand.',
      ),
    ).toBeInTheDocument();
  });

  it('zeigt bei 0 Adressen nur den Leerzustand, ohne große Kennzahl und ohne doppelte Zeile', async () => {
    setFetchReady({ empty: true });
    open();

    expect(await screen.findByText('Noch niemand hat bestätigt')).toBeInTheDocument();
    expect(screen.queryByText('bestätigte Adressen · Stand jetzt')).toBeNull();
    expect(screen.queryByText('Adressen mit bestätigter Einwilligung — Stand jetzt.')).toBeNull();
  });

  it('verweist für den Widerspruch auf die Sperrseite', async () => {
    setFetchReady();
    open();

    // EINMAL, im Fliesstext der Seite. Bis zum Redesign waren es zwei — der
    // zweite stand in der Hauptnavigation. Die hat seither genau vier
    // Einträge, und die Sperrliste ist ein Reiter unter Rundmail.
    const links = await screen.findAllByRole('link', {
      name: 'Newsletter-Sperre',
    });
    expect(links).toHaveLength(1);
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/broadcast/blocklist');
    }
  });
});
