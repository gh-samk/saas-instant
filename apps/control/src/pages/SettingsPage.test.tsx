import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { renderWithI18n } from '../test-support/render-with-i18n';
import App from '../App';

/**
 * [DW1]: Für einen BEREITS AKTIVEN TOTP-Faktor fehlte in den Einstellungen
 * jeder Weg zurück in den Einrichtungsdialog — es gab nur „Entfernen".
 *
 * Folge im Alltag: Wer das Telefon wechselt, musste den Faktor erst abschaffen
 * und stand dabei zwischenzeitlich mit einem Faktor weniger da. Folge in der
 * Prüfung: Der Ablauf „Dialog öffnen, abbrechen, mit dem alten Authenticator
 * anmelden" ließ sich über die Oberfläche gar nicht auslösen, obwohl der Code
 * ihn längst konnte.
 *
 * Die E-Mail-Zeile eine Position darüber machte es die ganze Zeit richtig
 * („Adresse ändern"). Dieser Test hält beide Zeilen auf derselben Bauform fest.
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
  setUpFactors: ['email-code', 'totp'],
  openRecoveryCodes: 8,
};

function setFetchReady(state: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes('/api/auth/csrf')) {
        return new Response(JSON.stringify({ csrfToken: 'abc' }), {
          status: 200,
        });
      }
      if (path.includes('/api/auth/me')) {
        return new Response(JSON.stringify({ ...state }), { status: 200 });
      }
      if (path.includes('/api/access/devices')) {
        return new Response(JSON.stringify({ devices: [] }), { status: 200 });
      }
      if (path.includes('/api/audit/security')) {
        return new Response(JSON.stringify(EVENTS), { status: 200 });
      }
      if (path.includes('/api/users')) {
        return new Response(JSON.stringify(ACCOUNTS), { status: 200 });
      }
      if (path.includes('/api/feature-flags')) {
        return new Response(
          JSON.stringify([
            {
              key: 'feedback',
              label: 'Feedback in den Instanzen',
              description: 'Zeigt den Punkt „Feedback geben".',
              active: true,
              default: true,
              changedAt: null,
            },
          ]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('Reiter „Funktionen"', () => {
  it('ist per Adresse erreichbar und zeigt den Feedback-Schalter', async () => {
    setFetchReady(STATE);
    window.history.pushState({}, '', '/settings?tab=features');
    renderWithI18n(<App />);

    expect(
      await screen.findByRole('switch', { name: 'Feedback in den Instanzen' }),
    ).toHaveAttribute('aria-checked', 'true');
  });
});

describe('[DW1] Ein aktiver TOTP-Faktor hat einen Wiedereinstiegspunkt', () => {
  it('bietet neben „Eingerichtet" einen Weg zurück in den Dialog', async () => {
    setFetchReady(STATE);
    window.history.pushState({}, '', '/settings');
    renderWithI18n(<App />);

    const changeButton = await screen.findByRole('button', {
      name: 'App wechseln',
    });
    expect(changeButton).toBeInTheDocument();

    // Dieselbe Bauform wie beim E-Mail-Faktor — die Zeile darüber.
    expect(
      screen.getByRole('button', { name: 'Adresse ändern' }),
    ).toBeInTheDocument();
  });

  it('öffnet damit den Dialog, ohne den aktiven Faktor anzutasten', async () => {
    setFetchReady(STATE);
    window.history.pushState({}, '', '/settings');
    renderWithI18n(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'App wechseln' }));

    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Authenticator-App wechseln' }),
      ).toBeInTheDocument(),
    );
    // Das Öffnen ist folgenlos: der Dialog sagt es zu, und der Server wird
    // erst mit „QR-Code anzeigen" überhaupt gefragt.
    expect(
      screen.getByText(/bisherige App bleibt gültig/i),
    ).toBeInTheDocument();
  });

  it('zeigt ohne aktiven Faktor weiterhin „Hinzufügen"', async () => {
    setFetchReady({
      ...STATE,
      totpSetUp: false,
      setUpFactors: ['email-code'],
    });
    window.history.pushState({}, '', '/settings');
    renderWithI18n(<App />);

    // „Hinzufügen" steht an der Authenticator-Zeile, sobald kein Faktor aktiv
    // ist — der Wiedereinstiegspunkt gehört dann nicht dorthin.
    await screen.findByRole('button', { name: 'Hinzufügen' });
    expect(
      screen.queryByRole('button', { name: 'App wechseln' }),
    ).not.toBeInTheDocument();
  });
});

const EVENTS = [
  {
    id: 'a1',
    timestamp: '2026-09-01T03:14:00.000Z',
    action: 'login.password.failure',
    text: 'Fehlgeschlagene Anmeldung (Passwort)',
    actor: 'sam',
    flagged: true,
    ip: '203.0.113.9',
  },
  {
    id: 'a2',
    timestamp: '2026-08-31T09:00:00.000Z',
    action: 'login.password.success',
    text: 'Anmeldung mit Passwort',
    actor: 'sam',
    flagged: false,
    ip: '203.0.113.9',
  },
];

const ACCOUNTS = [
  {
    id: 'b1',
    name: 'Testbetreiberin',
    username: 'test',
    email: 'test@example.com',
    role: 'owner',
    state: 'active',
    deactivatedAt: null,
    lastLoginAt: '2026-08-31T09:00:00.000Z',
    self: true,
  },
  {
    id: 'b2',
    name: 'Kollegin',
    username: 'kollegin@example.com',
    email: 'kollegin@example.com',
    role: 'administrator',
    state: 'without_access',
    deactivatedAt: null,
    lastLoginAt: null,
    self: false,
  },
];

/**
 * DIE VIER REITER DER EINSTELLUNGEN.
 *
 * Aus einer Scrollseite von 1500 Zeilen wurden vier Bereiche. Geprüft wird
 * das, was dabei schiefgehen kann: dass ein Bereich im falschen Reiter landet,
 * dass der offene Reiter nicht in der URL steht (dann lässt sich nicht darauf
 * verweisen), und dass die Nutzerverwaltung die drei Regeln durchsetzt, die
 * sie durchsetzen soll.
 */
describe('Einstellungen — vier Reiter', () => {
  it('zeigt zuerst die Zugangsdaten, nicht die Geräte', async () => {
    setFetchReady(STATE);
    window.history.pushState({}, '', '/settings');
    renderWithI18n(<App />);

    expect(
      await screen.findByRole('heading', { name: 'Anmeldemethoden' }),
    ).toBeVisible();
    // DER GESCHLOSSENE REITER IST GAR NICHT DA, nicht nur unsichtbar. Das ist
    // eine Entscheidung: Mit `hidden` liefen die Abfragen aller vier Reiter
    // beim Öffnen der Seite — auch die des Sicherheitsprotokolls und der
    // Nutzerliste, die beide Personenbezug haben. Was niemand sehen will,
    // wird auch nicht geholt.
    expect(screen.queryByRole('heading', { name: 'Geräte' })).toBeNull();
  });

  it('MERKT DEN OFFENEN REITER IN DER URL', async () => {
    // Damit lässt sich auf einen Reiter verweisen und ein Neuladen landet
    // wieder dort.
    setFetchReady(STATE);
    window.history.pushState({}, '', '/settings');
    renderWithI18n(<App />);

    fireEvent.click(
      await screen.findByRole('button', { name: /^Sicherheit/ }),
    );
    await waitFor(() => expect(window.location.search).toContain('tab=security'));
  });

  it('öffnet den Reiter aus der URL', async () => {
    setFetchReady(STATE);
    window.history.pushState({}, '', '/settings?tab=user');
    renderWithI18n(<App />);

    expect(
      await screen.findByRole('heading', { name: 'Nutzer' }),
    ).toBeInTheDocument();
  });
});

describe('Das Sicherheitsprotokoll', () => {
  it('zeigt Zeitpunkt MIT Uhrzeit — die Minute ist die Aussage', async () => {
    setFetchReady(STATE);
    window.history.pushState({}, '', '/settings?tab=security');
    renderWithI18n(<App />);

    const table = await screen.findByRole('table');
    // Drei Fehlversuche um 03:14 sind etwas anderes als drei über den Tag
    // verteilte. Ein reines Tagesdatum verlöre genau diese Aussage.
    expect(within(table).getByText(/03:14|05:14/)).toBeInTheDocument();
  });

  it('hebt eine Abweichung hervor, den Normalbetrieb nicht', async () => {
    setFetchReady(STATE);
    window.history.pushState({}, '', '/settings?tab=security');
    renderWithI18n(<App />);

    const table = await screen.findByRole('table');
    expect(
      within(table).getByText('Fehlgeschlagene Anmeldung (Passwort)'),
    ).toBeInTheDocument();
    expect(
      within(table).getByText('Anmeldung mit Passwort'),
    ).toBeInTheDocument();
  });

  it('BIETET KEIN LÖSCHEN AN — ein Audit-Log, das sich ändern lässt, ist keines', async () => {
    setFetchReady(STATE);
    window.history.pushState({}, '', '/settings?tab=security');
    renderWithI18n(<App />);

    const table = await screen.findByRole('table');
    expect(within(table).queryAllByRole('button')).toHaveLength(0);
    for (const forbidden of [/löschen/i, /leeren/i, /gelesen/i]) {
      expect(screen.queryByRole('button', { name: forbidden })).toBeNull();
    }
  });
});

describe('Nutzerverwaltung — alle können dasselbe', () => {
  async function openUser() {
    setFetchReady(STATE);
    window.history.pushState({}, '', '/settings?tab=user');
    renderWithI18n(<App />);
    return within((await screen.findByRole('table')).querySelector('tbody')!);
  }

  it('LÄSST DAS EIGENE KONTO IN RUHE — kein Knopf an der eigenen Zeile', async () => {
    // Wer sein eigenes Konto abschaltet, ist ausgesperrt und müsste jemand
    // anderen bitten, es rückgängig zu machen.
    const body = await openUser();
    const rows = body.getAllByRole('row');
    const own = within(rows[0]!);
    expect(own.getByText('(du)')).toBeInTheDocument();
    expect(own.queryAllByRole('button')).toHaveLength(0);
  });

  it('BIETET NIRGENDS EIN LÖSCHEN AN (R4)', async () => {
    // Ein gelöschtes Konto verlöre die Zuordnung seiner Audit-Einträge.
    await openUser();
    for (const forbidden of [/löschen/i, /entfernen$/i]) {
      expect(screen.queryByRole('button', { name: forbidden })).toBeNull();
    }
    expect(
      screen.getByRole('button', { name: /Zugang entziehen/ }),
    ).toBeInTheDocument();
  });

  it('BIETET KEINEN ROLLENWECHSEL AN — es gibt nur eine Rolle', async () => {
    // Alle Konten können dasselbe. Ein Knopf „Zu Mitarbeitend" verspräche
    // eine Abstufung, die es nicht gibt.
    await openUser();
    for (const forbidden of [
      /mitarbeitend/i,
      /administrator/i,
      /rolle/i,
      /rechte/i,
    ]) {
      expect(screen.queryByRole('button', { name: forbidden })).toBeNull();
    }
  });

  it('zeigt „Ohne Zugang" als eigenen Zustand und bietet einen neuen Link an', async () => {
    const body = await openUser();
    const second = within(body.getAllByRole('row')[1]!);
    expect(second.getByText('Ohne Zugang')).toBeInTheDocument();
    expect(
      second.getByRole('button', { name: /Neuer Link/ }),
    ).toBeInTheDocument();
  });
});

describe('Reiter „Sicherheit" in einer Portal-Sitzung', () => {
  it('zeigt die Wiederherstellungscodes der lokalen Anmeldung nur ohne Portal', async () => {
    setFetchReady(STATE);
    window.history.pushState({}, '', '/settings?tab=security');
    const local = renderWithI18n(<App />);
    expect(
      await screen.findByRole('button', { name: 'Neue Codes erzeugen' }),
    ).toBeInTheDocument();
    local.unmount();
    vi.unstubAllGlobals();

    setFetchReady({ ...STATE, viaPortal: true, accessRole: 'admin' });
    renderWithI18n(<App />);
    expect(await screen.findByText('Datenverschlüsselung')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Neue Codes erzeugen' })).toBeNull();
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

describe('Einstellungen — Bereichswahl auf dem Telefon', () => {
  it('ersetzt die Chipleiste unter 640 px durch eine Auswahlliste mit allen Bereichen', async () => {
    stubNarrow();
    setFetchReady(STATE);
    window.history.pushState({}, '', '/settings');
    renderWithI18n(<App />);

    const select = await screen.findByLabelText('Bereich der Einstellungen');
    expect(select.tagName).toBe('SELECT');
    // Chips und Liste nie zugleich.
    expect(screen.queryByRole('group', { name: 'Bereich der Einstellungen' })).toBeNull();
    expect(within(select).getAllByRole('option').length).toBeGreaterThanOrEqual(6);
  });

  it('wechselt den Bereich über die Liste und schreibt ihn in die URL', async () => {
    stubNarrow();
    setFetchReady(STATE);
    window.history.pushState({}, '', '/settings');
    renderWithI18n(<App />);

    const select = await screen.findByLabelText('Bereich der Einstellungen');
    fireEvent.change(select, { target: { value: 'user' } });
    await waitFor(() => expect(window.location.search).toContain('tab=user'));
    expect(await screen.findByRole('heading', { name: 'Nutzer' })).toBeInTheDocument();
    expect(screen.getByLabelText('Bereich der Einstellungen')).toHaveValue('user');
  });

  it('behält ab 640 px die Chips (Gruppe, aria-pressed)', async () => {
    setFetchReady(STATE);
    window.history.pushState({}, '', '/settings');
    renderWithI18n(<App />);

    const group = await screen.findByRole('group', { name: 'Bereich der Einstellungen' });
    expect(within(group).getAllByRole('button')[0]).toHaveAttribute('aria-pressed');
    expect(screen.queryByRole('combobox', { name: 'Bereich der Einstellungen' })).toBeNull();
  });
});
