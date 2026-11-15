import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import App from '../App';

/**
 * Der Rahmen der Verwaltung nach dem Redesign.
 *
 * DREI ZUSAGEN, und jede davon ist im Abnahmekatalog des Designpakets
 * einzeln aufgeführt:
 *
 * 1. Die Seitenleiste hat GENAU die vorgesehenen Einträge — Einwilligungen
 *    und Sperrliste sind keine Menüpunkte mehr.
 * 2. Zähler stehen dort NUR bei Handlungsbedarf. Eine Null ist keiner.
 * 3. Die Markierung bleibt auf Unterseiten stehen: Wer in einer Organisation
 *    steht, ist immer noch „bei den Organisationen".
 */

const STATE = {
  user: {
    id: 'b1',
    name: 'Testbetreiberin',
    username: 'test',
    email: 'test@example.com',
    role: 'inhaber',
  },
  passwordSet: true,
  passkeyCount: 0,
  totpSetUp: true,
  emailCodeSetUp: true,
  loginCodeEmail: 'test@example.com',
  setUpFactors: ['totp'],
  openRecoveryCodes: 8,
};

function arrangeFetch(counter: { tasksUrgent: number; invoicesOpen: number }) {
  const called = vi.fn(async (input: unknown) => {
    const path = String(input);
    if (path.includes('/api/auth/csrf')) {
      return new Response(JSON.stringify({ csrfToken: 'abc' }), { status: 200 });
    }
    if (path.includes('/api/auth/me')) {
      return new Response(JSON.stringify(STATE), { status: 200 });
    }
    if (path.includes('/api/navigation/counters')) {
      return new Response(JSON.stringify(counter), { status: 200 });
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

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('Rahmen der Verwaltung', () => {
  it('hat genau fünf Hauptziele plus Einstellungen', async () => {
    arrangeFetch({ tasksUrgent: 0, invoicesOpen: 0 });
    window.history.pushState({}, '', '/');
    render(<App />);

    const main = within(
      await screen.findByRole('navigation', { name: 'Hauptnavigation' }),
    );
    expect(main.getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Heute',
      'Organisationen',
      'Instanzen',
      'Rechnungen',
      'Rundmail',
    ]);

    const account = within(screen.getByRole('navigation', { name: 'Konto' }));
    expect(account.getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Einstellungen',
    ]);
  });

  it('FÜHRT EINWILLIGUNGEN UND SPERRLISTE NICHT MEHR ALS MENÜPUNKT', async () => {
    // Sie sind seit dem Redesign Reiter unter Rundmail. Ihre alten Routen
    // bleiben erreichbar — nur die Leiste zeigt sie nicht mehr.
    arrangeFetch({ tasksUrgent: 0, invoicesOpen: 0 });
    window.history.pushState({}, '', '/');
    render(<App />);

    const main = within(
      await screen.findByRole('navigation', { name: 'Hauptnavigation' }),
    );
    expect(main.queryByRole('link', { name: /Einwilligungen/ })).toBeNull();
    expect(main.queryByRole('link', { name: /Newsletter-Sperre/ })).toBeNull();
  });

  it('zeigt den Zähler nur, wenn es etwas zu tun gibt', async () => {
    arrangeFetch({ tasksUrgent: 9, invoicesOpen: 3 });
    window.history.pushState({}, '', '/');
    render(<App />);

    const today = await screen.findByRole('link', { name: /Heute/ });
    await waitFor(() => expect(today.textContent).toContain('9'));
    // Der bernsteinfarbene Zähler an den Rechnungen, seit Etappe 4.
    expect(
      screen.getByRole('link', { name: /Rechnungen/ }).textContent,
    ).toContain('3');
  });

  it('ZEIGT BEI NULL GAR KEINE PILLE — eine Null ist kein Handlungsbedarf', async () => {
    // Ein roter Kreis mit einer Null ist eine Warnung ohne Anlass. Wer sie
    // einmal ignoriert hat, ignoriert sie auch, wenn eine Drei darin steht.
    arrangeFetch({ tasksUrgent: 0, invoicesOpen: 0 });
    window.history.pushState({}, '', '/');
    render(<App />);

    const today = await screen.findByRole('link', { name: /Heute/ });
    await waitFor(() => expect(today.textContent).toBe('Heute'));
  });

  it('hält die Markierung auf Unterseiten der Rundmail', async () => {
    // Wer die Sperrliste offen hat, ist immer noch „bei der Rundmail". Ohne
    // das verlöre die Leiste beim Öffnen jeder Unterseite ihre Markierung.
    arrangeFetch({ tasksUrgent: 0, invoicesOpen: 0 });
    window.history.pushState({}, '', '/newsletter-block');
    render(<App />);

    // AM LINK, nicht am Symbol: Das Symbol ist `aria-hidden` und damit fuer
    // eine Bildschirmleserin nicht vorhanden. Vor dem Redesign stand die
    // Markierung genau dort — sichtbar und zugleich unhoerbar.
    const broadcast = await screen.findByRole('link', { name: /Rundmail/ });
    expect(broadcast).toHaveAttribute('aria-current', 'page');
  });

  it('trägt in der Kopfleiste eine eigene Beschriftung für die Schnellsuche', async () => {
    // „Organisationen durchsuchen" heisst bereits das Feld AUF der
    // Organisationsseite. Zwei Bedienelemente mit demselben Namen sind für
    // eine Bildschirmleserin nicht unterscheidbar.
    arrangeFetch({ tasksUrgent: 0, invoicesOpen: 0 });
    window.history.pushState({}, '', '/');
    render(<App />);

    expect(await screen.findByLabelText('Schnellsuche')).toBeInTheDocument();
  });
});

/**
 * Der Abmelden-Knopf gehört an den rechten Rand der Kopfleiste.
 *
 * Er klebte am Suchfeld: Das hat `flex-1`, wird auf grossen Bildschirmen aber
 * auf 460px gedeckelt — der frei bleibende Raum lag danach rechts vom Knopf.
 * jsdom rechnet kein Layout, deshalb prüft dieser Test die Ursache statt der
 * Wirkung: die Randregel, die den Knopf schiebt, und seine Stellung als
 * letztes Bedienelement der Kopfleiste.
 */
describe('Kopfleiste — Stellung des Abmelden-Knopfes', () => {
  it('schiebt den Abmelden-Knopf an den rechten Rand', async () => {
    arrangeFetch({ tasksUrgent: 0, invoicesOpen: 0 });
    window.history.pushState({}, '', '/');
    render(<App />);

    const button = await screen.findByRole('button', { name: 'Abmelden' });
    expect(button.className).toContain('ml-auto');
  });

  it('der Knopf ist das letzte Element der Kopfleiste', async () => {
    arrangeFetch({ tasksUrgent: 0, invoicesOpen: 0 });
    window.history.pushState({}, '', '/');
    render(<App />);

    const button = await screen.findByRole('button', { name: 'Abmelden' });
    const header = button.closest('header');
    expect(header).not.toBeNull();
    expect(header!.lastElementChild).toBe(button);
  });
});
