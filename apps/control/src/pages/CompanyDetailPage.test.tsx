import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithI18n } from '../test-support/render-with-i18n';
import App from '../App';

/**
 * Die Detailseite mit dem gemeinsamen Verlauf.
 *
 * Geprüft wird das, was fachlich trägt: Notizen, Statuswechsel und Wechsel
 * der Ansprechpartnerin stehen in EINER Liste; systemerzeugte Einträge tragen
 * keinen Bearbeiten-Weg (der Server lehnt sie mit `409 notiz_vom_system` ab);
 * und der Wechsel der Ansprechpartnerin läuft über seinen eigenen Endpunkt,
 * weil PATCH das Feld bewusst nicht annimmt.
 */

const IDENTIFIER = '11111111-1111-4111-8111-111111111111';

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

const COMPANY = {
  id: IDENTIFIER,
  name: 'Solawi Rheintal',
  legalForm: 'e. V.',
  website: null,
  street: 'Hauptstraße',
  houseNumber: '12',
  postalCode: '79098',
  city: 'Freiburg',
  country: 'Deutschland',
  billingName: null,
  billingStreet: null,
  billingHouseNumber: null,
  billingPostalCode: null,
  billingCity: null,
  billingCountry: null,
  billingEmail: null,
  contactName: 'Lena Brandt',
  contactEmail: 'contact@example.com',
  contactPhone: null,
  contactRole: 'Vorstand',
  deputyName: null,
  deputyEmail: null,
  deputyPhone: null,
  deputyRole: null,
  status: 'paying',
  lastStatusChangeAt: '2026-05-01',
  priceTier: 'Standard',
  buyerType: 'business',
  vatId: null,
  buyerReference: null,
  electronicAddress: null,
  electronicAddressScheme: null,
  paymentInterval: 'yearly',
  paymentMethod: 'bank_transfer',
  paymentDetailsStored: true,
  instanceStartDate: null,
  newsletterConsentStatus: null,
  source: 'phone',
  notes: null,
  createdAt: '2026-04-02T09:12:00.000Z',
  updatedAt: '2026-05-01T10:00:00.000Z',
};

const HISTORY = [
  {
    id: 'n2',
    companyId: IDENTIFIER,
    date: '2026-05-01',
    text: 'Status gewechselt: Testphase → Zahlend, 01.05.2026',
    bySystem: true,
    createdAt: '2026-05-01T10:00:00.000Z',
  },
  {
    id: 'n1',
    companyId: IDENTIFIER,
    date: '2026-04-20',
    text: 'Telefonat: Beschluss ist für Ende April angesetzt.',
    bySystem: false,
    createdAt: '2026-04-20T08:00:00.000Z',
  },
];

const INSTANCE_DETAIL = {
  id: 'i1',
  companyId: IDENTIFIER,
  subdomain: 'solawi-rheintal',
  status: 'active',
  appVersion: '0.5.2',
  createdAt: '2026-06-01T09:00:00.000Z',
  archivedAt: null,
  message: null,
  metrics: null,
  backup: { last: null, missing: false },
  invitationOpen: false,
  configuredAt: null,
  coolifyCreated: false,
};

interface Options {
  website?: string | null;
  /** Überschreibt Felder der Organisation (Empfängerart, Leitweg-ID …). */
  company?: Record<string, unknown>;
  /** Die Organisation hat bereits eine Instanz. */
  instance?: boolean;
  companyStatus?: number;
  notePatch?: () => Response;
  paymentDetailsStatus?: number;
  /** Antwort auf die VOLLSTÄNDIGE Löschung — 409, wenn etwas im Weg steht. */
  deleteStatus?: number;
}

function setFetchReady(options: Options = {}) {
  const called = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (path.includes('/api/auth/csrf')) {
      return new Response(JSON.stringify({ csrfToken: 'abc' }), { status: 200 });
    }
    if (path.includes('/api/auth/me')) {
      return new Response(JSON.stringify(STATE), { status: 200 });
    }
    if (path.includes('/api/notes') && method === 'PATCH') {
      return (
        options.notePatch?.() ??
        new Response(JSON.stringify(HISTORY[1]), { status: 200 })
      );
    }
    if (path.includes('/api/notes')) {
      return new Response(JSON.stringify({ notes: HISTORY }), { status: 200 });
    }
    if (path.includes('/delete-contact-data')) {
      return new Response(
        JSON.stringify({
          cleanedUpFields: ['contactName'],
          deletedNotes: 1,
          rewrittenNotes: 0,
        }),
        { status: 200 },
      );
    }
    // VOR `/zahlungsdaten` und NACH `/kontaktdaten-loeschen`: Der Pfad der
    // vollständigen Löschung endet auf `/loeschen`, der andere auf
    // `-loeschen` — sie treffen einander nicht, aber die Reihenfolge hier
    // soll das nicht erst beweisen müssen.
    if (path.includes('/delete')) {
      if ((options.deleteStatus ?? 200) !== 200) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'company_not_deletable',
              message:
                'Diese Organisation lässt sich nicht löschen. Für diese ' +
                'Organisation wurde eine Instanz eingerichtet. Zu dieser ' +
                'Organisation gibt es Rechnungen.',
            },
          }),
          { status: options.deleteStatus },
        );
      }
      return new Response(
        JSON.stringify({
          name: 'Solawi Rheintal',
          deletedNotes: 2,
          deletedPreviews: 1,
          deletedSendRows: 1,
          deletedConsents: 0,
          detachedBlockEntries: 1,
        }),
        { status: 200 },
      );
    }
    if (path.includes('/payment-details')) {
      if ((options.paymentDetailsStatus ?? 200) !== 200) {
        return new Response(
          JSON.stringify({
            error: { code: 'evidence_required', message: 'Nachweis erforderlich.' },
          }),
          { status: options.paymentDetailsStatus },
        );
      }
      return new Response(
        JSON.stringify({
          companyId: IDENTIFIER,
          iban: 'DE02120300000000202051',
          sepaMandateReference: 'SOLAWI-2026-01',
          sepaMandateDate: '2026-05-01',
          differingAmount: '480.00',
        }),
        { status: 200 },
      );
    }
    if (path.includes('/invoices')) {
      // Zu dieser Organisation gehört keine Rechnung. Ohne diesen Zweig fiele
      // die Abfrage in den Sammelzweig weiter unten, und die Karte bekäme eine
      // Organisation gereicht, wo sie eine Liste erwartet.
      return new Response('[]', { status: 200 });
    }
    if (path.includes('/instance')) {
      // Zu dieser Organisation gehört keine Instanz. Ohne diesen Zweig fiele
      // die Abfrage in den Sammelzweig weiter unten und die Karte bekäme eine
      // Organisation als Instanz gereicht.
      if (options.instance === true) {
        return new Response(JSON.stringify(INSTANCE_DETAIL), { status: 200 });
      }
      return new Response('null', { status: 200 });
    }
    if (path.includes('/contact-person')) {
      return new Response(
        JSON.stringify({ ...COMPANY, contactName: 'Tim Roth' }),
        { status: 200 },
      );
    }
    if (/\/api\/companies(\?|$)/.test(path)) {
      // Die Liste, auf der die Seite nach der Löschung landet.
      return new Response(
        JSON.stringify({
          companies: [],
          total: 0,
          page: 1,
          perPage: 25,
          countPerStatus: {},
        }),
        { status: 200 },
      );
    }
    if (path.includes('/api/companies/')) {
      const status = options.companyStatus ?? 200;
      if (status === 404) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'company_not_found',
              message: 'Diese Organisation gibt es nicht (mehr).',
            },
          }),
          { status: 404 },
        );
      }
      return new Response(
        JSON.stringify({ ...COMPANY, website: options.website ?? null, ...options.company }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', called);
  return called;
}

/**
 * Öffnet die Detailseite — seit dem Redesign auf einem bestimmten REITER.
 *
 * Die Seite ist keine lange Scrollseite mehr, sondern sechs benannte Orte.
 * Der offene Reiter steht in der URL, damit ein Link (etwa aus einer
 * Dashboard-Aufgabe) genau dorthin führen kann, wo die Handlung stattfindet.
 * Die Tests nutzen denselben Weg.
 */
function open(tab?: string) {
  const attachment = tab === undefined ? '' : `?tab=${tab}`;
  window.history.pushState({}, '', `/companies/${IDENTIFIER}${attachment}`);
  renderWithI18n(<App />);
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('Organisations-Detailseite', () => {
  it('zeigt Stammdaten und den Status', async () => {
    setFetchReady();
    open('contract');

    expect(
      await screen.findByRole('heading', { name: 'Solawi Rheintal' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Zahlend')).toBeInTheDocument();
    // Pilotbeschluss und Überprüfungstermin gibt es nicht mehr.
    expect(screen.queryByText('Überprüfungstermin')).toBeNull();
  });

  it('rendert eine Website nur bei http(s) als Link (F11)', async () => {
    setFetchReady({ website: 'javascript:alert(document.cookie)' });
    open('contract');
    await screen.findByRole('heading', { name: 'Solawi Rheintal' });
    expect(screen.getByText('javascript:alert(document.cookie)')).toBeInTheDocument();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it('rendert eine https-Website als Link (F11)', async () => {
    setFetchReady({ website: 'https://example.org' });
    open('contract');
    await screen.findByRole('heading', { name: 'Solawi Rheintal' });
    expect(screen.getByRole('link', { name: 'https://example.org' })).toHaveAttribute(
      'href',
      'https://example.org',
    );
  });

  it('lädt die Bankverbindung NICHT mit der Seite', async () => {
    // Vorher genügte ein 25 Stunden altes Sitzungs-Cookie, um an einer
    // gewöhnlichen Detailansicht die IBAN mitzulesen. Die Detailantwort führt
    // die Werte deshalb gar nicht mehr — sichtbar wird nur, DASS es welche gibt.
    const called = setFetchReady();
    open('contract');

    await screen.findByRole('heading', { name: 'Solawi Rheintal' });
    expect(
      screen.getByText('Bankverbindung und SEPA-Mandat sind hinterlegt.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Zahlungsdaten anzeigen/ }),
    ).toBeInTheDocument();
    // Ungefragt fragt die Seite den geschützten Endpunkt nicht an.
    expect(
      called.mock.calls.some((c) => String(c[0]).includes('/payment-details')),
    ).toBe(false);
  });

  it('holt die Zahlungsdaten erst auf ausdrückliche Anforderung — per POST', async () => {
    const called = setFetchReady();
    open('contract');

    await screen.findByRole('heading', { name: 'Solawi Rheintal' });
    fireEvent.click(screen.getByRole('button', { name: /Zahlungsdaten anzeigen/ }));

    expect(await screen.findByText('DE02120300000000202051')).toBeInTheDocument();
    const call = called.mock.calls.find((c) =>
      String(c[0]).includes('/payment-details/reveal'),
    );
    // POST, obwohl es ein Lesevorgang ist: Der Server liest den Nachweis aus
    // dem Rumpf, und ein GET hat keinen.
    expect((call?.[1] as RequestInit | undefined)?.method).toBe('POST');
  });

  it('fragt bei 401 nach dem zweiten Faktor und blendet die Daten wieder aus', async () => {
    setFetchReady({ paymentDetailsStatus: 401 });
    open('contract');

    await screen.findByRole('heading', { name: 'Solawi Rheintal' });
    fireEvent.click(screen.getByRole('button', { name: /Zahlungsdaten anzeigen/ }));

    // Muster aus Etappe 1: erst ohne Nachweis versuchen, dann nachfragen.
    expect(
      await screen.findByRole('heading', { name: 'Zahlungsdaten anzeigen' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Aktuelles Passwort/i)).toBeInTheDocument();
  });

  it('verlangt für die Löschung den abgetippten Namen', async () => {
    setFetchReady();
    open('privacy');

    await screen.findByRole('heading', { name: 'Solawi Rheintal' });
    fireEvent.click(screen.getByRole('button', { name: /^Kontaktdaten löschen …$/ }));

    const button = await screen.findByRole('button', {
      name: 'Kontaktdaten endgültig löschen',
    });
    expect(button).toBeDisabled();

    const field = screen.getByLabelText(/Namen der Organisation eingeben/);
    fireEvent.change(field, { target: { value: 'Solawi Rhein' } });
    expect(button).toBeDisabled();
    expect(screen.getByText('Der Name stimmt noch nicht überein.')).toBeInTheDocument();

    fireEvent.change(field, { target: { value: 'Solawi Rheintal' } });
    expect(button).toBeEnabled();
  });

  it('sagt vorher, dass auch die eigenen Notizen verschwinden', async () => {
    // Der Server löscht ALLE selbst erfassten Notizen mit, nicht nur die
    // Kontaktangaben. Eine Löschung, deren Umfang man erst hinterher sieht,
    // ist keine Einwilligung.
    setFetchReady();
    open('privacy');

    await screen.findByRole('heading', { name: 'Solawi Rheintal' });
    fireEvent.click(screen.getByRole('button', { name: /^Kontaktdaten löschen …$/ }));

    expect(
      await screen.findByText(/alle selbst erfassten Notizen/),
    ).toBeInTheDocument();
    expect(screen.getByText(/der Status und der gesamte Statusverlauf/)).toBeInTheDocument();
  });

  it('führt Notizen und Statuswechsel in EINER Liste', async () => {
    setFetchReady();
    open('history');

    const handwritten = await screen.findByText(
      'Telefonat: Beschluss ist für Ende April angesetzt.',
    );
    const systemGenerated = screen.getByText(
      'Status gewechselt: Testphase → Zahlend, 01.05.2026',
    );
    // Beide hängen unter derselben <ul> — keine zwei getrennten Listen.
    const list = handwritten.closest('ul');
    expect(list).not.toBeNull();
    expect(systemGenerated.closest('ul')).toBe(list);
  });

  it('bietet für systemerzeugte Einträge keinen Bearbeiten-Weg an', async () => {
    setFetchReady();
    open('history');

    await screen.findByText('Telefonat: Beschluss ist für Ende April angesetzt.');
    // Genau ein Eintrag ist von Hand geschrieben — und nur der ist änderbar.
    expect(screen.getAllByRole('button', { name: 'Bearbeiten' })).toHaveLength(1);

    const systemRow = screen
      .getByText('Status gewechselt: Testphase → Zahlend, 01.05.2026')
      .closest('li');
    expect(systemRow).not.toBeNull();
    expect(
      within(systemRow as HTMLElement).queryByRole('button', {
        name: 'Bearbeiten',
      }),
    ).not.toBeInTheDocument();
  });

  it('zeigt den Wortlaut des Servers, wenn er eine Notiz doch ablehnt', async () => {
    // Der Weg wird gar nicht angeboten — verlassen wird sich darauf trotzdem
    // nicht: Kommt der 409, steht sein Text da, statt still nichts zu tun.
    setFetchReady({
      notePatch: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'note_by_system',
              message:
                'Diese Notiz hat das System erzeugt. Sie lässt sich weder ändern noch löschen.',
            },
          }),
          { status: 409 },
        ),
    });
    open('history');

    await screen.findByText('Telefonat: Beschluss ist für Ende April angesetzt.');
    fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Speichern' }));

    expect(
      await screen.findByText(
        'Diese Notiz hat das System erzeugt. Sie lässt sich weder ändern noch löschen.',
      ),
    ).toBeInTheDocument();
  });

  it('wechselt die Ansprechpartnerin über den eigenen Endpunkt', async () => {
    const called = setFetchReady();
    open('contract');

    await screen.findByRole('heading', { name: 'Solawi Rheintal' });
    fireEvent.click(screen.getByRole('button', { name: 'Wechseln' }));

    fireEvent.change(await screen.findByLabelText('Name'), {
      target: { value: 'Tim Roth' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt wechseln' }));

    await waitFor(() => {
      const call = called.mock.calls.find((c) =>
        String(c[0]).includes('/contact-person'),
      );
      expect(call).toBeDefined();
      expect((call?.[1] as RequestInit | undefined)?.method).toBe('POST');
    });
    // Kein PATCH auf die Organisation — das Feld nimmt der Server dort nicht an.
    expect(
      called.mock.calls.some(
        (c) => (c[1] as RequestInit | undefined)?.method === 'PATCH',
      ),
    ).toBe(false);
  });

  it('verlangt bei einer Behörde die Leitweg-ID und speichert sonst die E-Rechnungsdaten', async () => {
    const called = setFetchReady();
    open('contract');

    await screen.findByRole('heading', { name: 'Solawi Rheintal' });
    // Eine Organisation ohne Behörde und ohne Leitweg-ID zeigt die Karte
    // nicht, aber einen Link, der sie öffnet.
    fireEvent.click(
      screen.getByRole('button', { name: 'E-Rechnung für Behörden einrichten' }),
    );
    fireEvent.change(await screen.findByLabelText('Art der Empfängerin'), {
      target: { value: 'authority' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    expect(
      await screen.findByText(/ist die Leitweg-ID Pflicht/),
    ).toBeInTheDocument();
    const patchCalls = () =>
      called.mock.calls.filter(
        (c) => (c[1] as RequestInit | undefined)?.method === 'PATCH',
      );
    expect(patchCalls()).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(/Leitweg-ID \(Pflicht\)/), {
      target: { value: '04011000-1234512345-06' },
    });
    fireEvent.change(screen.getByLabelText('USt-IdNr.'), {
      target: { value: 'de 123456789' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    const body = JSON.parse(String((patchCalls()[0][1] as RequestInit).body));
    expect(body).toMatchObject({
      buyerType: 'authority',
      buyerReference: '04011000-1234512345-06',
      vatId: 'DE123456789',
      electronicAddress: null,
      electronicAddressScheme: null,
    });
  });

  it('zeigt die E-Rechnungs-Karte bei einer Behörde samt Daten', async () => {
    setFetchReady({
      company: { buyerType: 'authority', buyerReference: '04011000-1234512345-06' },
    });
    open('contract');

    await screen.findByRole('heading', { name: 'Solawi Rheintal' });
    expect(
      screen.getByRole('heading', { name: 'E-Rechnung' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Behörde / öffentlicher Auftraggeber')).toBeInTheDocument();
    expect(screen.getByText('04011000-1234512345-06')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'E-Rechnung für Behörden einrichten' }),
    ).toBeNull();
  });

  it('blendet die E-Rechnungs-Karte ohne Behörde und Leitweg-ID aus und lässt den Weg dorthin offen', async () => {
    setFetchReady();
    open('contract');

    await screen.findByRole('heading', { name: 'Solawi Rheintal' });
    expect(screen.queryByRole('heading', { name: 'E-Rechnung' })).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'E-Rechnung für Behörden einrichten' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'E-Rechnung' }),
    ).toBeInTheDocument();
    expect(await screen.findByLabelText('Art der Empfängerin')).toBeInTheDocument();
  });

  it('zeigt bei 404 einen benannten Weg zurück, keinen leeren Bildschirm', async () => {
    setFetchReady({ companyStatus: 404 });
    open();

    expect(
      await screen.findByText('Organisation nicht gefunden'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Zu allen Organisationen' }),
    ).toBeInTheDocument();
  });

  it('löst die Löschung tatsächlich aus — der Knopf hängt am richtigen Formular', async () => {
    // Gefunden durch einen echten Klick, nicht durch Lesen: Die Karte auf der
    // Seite trug als Sprungmarke dieselbe `id` wie das Formular im Dialog.
    // `button.form` zeigte damit auf ein <div>, und der Absende-Knopf tat
    // stillschweigend gar nichts. Zwei gleiche `id` im Dokument sind hier kein
    // Schönheitsfehler, sondern der Unterschied zwischen „löscht" und
    // „behauptet zu löschen".
    const called = setFetchReady();
    open('privacy');

    await screen.findByRole('heading', { name: 'Solawi Rheintal' });
    fireEvent.click(screen.getByRole('button', { name: /^Kontaktdaten löschen …$/ }));

    fireEvent.change(
      await screen.findByLabelText(/Namen der Organisation eingeben/),
      { target: { value: 'Solawi Rheintal' } },
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Kontaktdaten endgültig löschen' }),
    );

    await waitFor(() => {
      const call = called.mock.calls.find((c) =>
        String(c[0]).includes('/delete-contact-data'),
      );
      expect(call).toBeDefined();
      expect((call?.[1] as RequestInit | undefined)?.method).toBe('POST');
      expect(String((call?.[1] as RequestInit | undefined)?.body)).toContain(
        'Solawi Rheintal',
      );
    });
  });

  it('löscht die ganze Organisation und verlässt die Seite danach', async () => {
    // WEGNAVIGIEREN GEHÖRT ZUM VORGANG. Bliebe die Seite stehen und lüde
    // nach, käme ein 404 zurück — „Organisation nicht gefunden" als Ergebnis
    // einer geglückten Löschung.
    const called = setFetchReady();
    open('privacy');

    await screen.findByRole('heading', { name: 'Solawi Rheintal' });
    fireEvent.click(
      screen.getByRole('button', { name: /^Organisation löschen …$/ }),
    );

    fireEvent.change(
      await screen.findByLabelText(/Namen der Organisation eingeben/),
      { target: { value: 'Solawi Rheintal' } },
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Organisation endgültig löschen' }),
    );

    await waitFor(() => {
      const call = called.mock.calls.find((c) =>
        /\/companies\/[^/]+\/delete$/.test(String(c[0])),
      );
      expect(call).toBeDefined();
      expect((call?.[1] as RequestInit | undefined)?.method).toBe('POST');
    });
    await waitFor(() => {
      expect(window.location.pathname).toBe('/companies');
    });
  });

  it('zeigt beim 409 die Hindernisse und lässt die Seite stehen', async () => {
    // Die Meldung des Servers IST die Erklärung — sie zählt alles auf, was im
    // Weg steht. Sie zu ersetzen hieße, dem Anwender die Auskunft zu nehmen,
    // die er braucht, um weiterzukommen.
    setFetchReady({ deleteStatus: 409 });
    open('privacy');

    await screen.findByRole('heading', { name: 'Solawi Rheintal' });
    fireEvent.click(
      screen.getByRole('button', { name: /^Organisation löschen …$/ }),
    );
    fireEvent.change(
      await screen.findByLabelText(/Namen der Organisation eingeben/),
      { target: { value: 'Solawi Rheintal' } },
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Organisation endgültig löschen' }),
    );

    const message = await screen.findByRole('alert');
    expect(message.textContent).toContain('Instanz');
    expect(message.textContent).toContain('Rechnungen');
    expect(window.location.pathname).toContain('/companies/');
  });

  it('hält Sprungmarke und Formular-Kennung auseinander', async () => {
    setFetchReady();
    open('privacy');

    await screen.findByRole('heading', { name: 'Solawi Rheintal' });
    // Die Sprungmarke der Dashboard-Aufgabe zeigt auf die KARTE …
    const anchor = document.getElementById('contact-data-delete');
    expect(anchor).not.toBeNull();
    expect(anchor?.tagName).not.toBe('FORM');
    // … und keine Kennung kommt doppelt vor.
    const all = [...document.querySelectorAll('[id]')].map((e) => e.id);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('Organisations-Detailseite — Kopf und leere Felder', () => {
  it('zeigt ohne Instanz „Instanz anlegen" als Hauptaktion und den Rest im Menü „Weitere"', async () => {
    setFetchReady();
    open();

    expect(
      await screen.findByRole('button', { name: 'Instanz anlegen' }),
    ).toBeInTheDocument();
    // Nicht mehr als drei beschriftungslose Symbole nebeneinander.
    expect(screen.queryByRole('button', { name: /Stammdaten bearbeiten/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Weitere/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Rechnung anlegen' })).toBeInTheDocument();
    expect(
      within(menu).getByRole('menuitem', { name: 'E-Mail an contact@example.com' }),
    ).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Stammdaten bearbeiten' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Status ändern' })).toBeInTheDocument();
  });

  it.each(['inquiry'])(
    'zeigt bei Status %s „Status ändern" als Hauptaktion statt „Instanz anlegen"',
    async (status) => {
      setFetchReady({ company: { status } });
      open();
      fireEvent.click(await screen.findByRole('button', { name: 'Status ändern' }));
      expect(screen.queryByRole('button', { name: 'Instanz anlegen' })).toBeNull();
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
    },
  );

  it('„Instanz anlegen" führt in den Reiter Instanz und öffnet den Anlegen-Dialog', async () => {
    setFetchReady();
    open();

    fireEvent.click(await screen.findByRole('button', { name: 'Instanz anlegen' }));
    expect(window.location.search).toContain('tab=instance');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('öffnet mit ?create=instance den Anlegen-Dialog und entfernt den Parameter', async () => {
    setFetchReady();
    open('instance&create=instance');

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).not.toContain('create='));
    expect(window.location.search).toContain('tab=instance');
  });

  it('zeigt „Rechnung anlegen" als Hauptaktion, sobald es eine Instanz gibt', async () => {
    setFetchReady({ instance: true });
    open();

    expect(
      await screen.findByRole('button', { name: 'Rechnung anlegen' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Instanz anlegen' })).toBeNull();
  });

  it('bietet statt „—" bei leeren optionalen Feldern „+ … hinzufügen" an, das den Block öffnet', async () => {
    setFetchReady();
    open('contract');

    await screen.findByRole('heading', { name: 'Solawi Rheintal' });
    fireEvent.click(screen.getByRole('button', { name: '+ Website hinzufügen' }));
    expect(await screen.findByLabelText('Website')).toBeInTheDocument();
  });

  it('zeigt bei gesetzter Rechnungs-E-Mail ohne Anschrift „wie die Stammdaten" für Name und Anschrift', async () => {
    setFetchReady({ company: { billingEmail: 'buchhaltung@example.com' } });
    open('contract');

    await screen.findByRole('heading', { name: 'Solawi Rheintal' });
    expect(screen.getByText('buchhaltung@example.com')).toBeInTheDocument();
    expect(screen.getAllByText('wie die Stammdaten')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: '+ Name hinzufügen' })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Anschrift hinzufügen' })).toBeNull();
  });

  it('fasst die Rechnungsadresse „wie die Stammdaten" in eine Zeile', async () => {
    setFetchReady();
    open('contract');

    await screen.findByRole('heading', { name: 'Solawi Rheintal' });
    expect(screen.getByText('Rechnungsadresse: wie die Stammdaten.')).toBeInTheDocument();
  });

  it('zeigt das Aufnahmeformular nur in der Testphase und nach den Stammdaten', async () => {
    setFetchReady({ company: { status: 'trial' } });
    open('contract');

    const intake = await screen.findByRole('heading', { name: 'Aufnahmeformular' });
    const master = screen.getByRole('heading', { name: 'Stammdaten' });
    expect(
      master.compareDocumentPosition(intake) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('blendet das Aufnahmeformular später aus und lässt es per Link zurückholen', async () => {
    setFetchReady();
    open('contract');

    await screen.findByRole('heading', { name: 'Solawi Rheintal' });
    expect(screen.queryByRole('heading', { name: 'Aufnahmeformular' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Aufnahmeformular anzeigen' }));
    expect(
      await screen.findByRole('heading', { name: 'Aufnahmeformular' }),
    ).toBeInTheDocument();
  });
});

describe('Organisations-Detailseite — die sechs Reiter', () => {
  it('zeigt genau sechs Reiter und startet auf „Überblick"', async () => {
    setFetchReady();
    open();

    const bar = within(
      await screen.findByRole('group', { name: 'Bereich der Organisation' }),
    );
    expect(bar.getAllByRole('button').map((k) => k.textContent)).toEqual([
      'Überblick',
      'Instanz',
      'Rechnungen',
      'Kontakt & Vertrag',
      'Verlauf',
      'Datenschutz',
    ]);
    expect(bar.getByRole('button', { name: 'Überblick' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('SCHREIBT DEN REITER IN DIE URL — damit ein Link genau dorthin führt', async () => {
    // Eine Dashboard-Aufgabe „Instanz anlegen" soll im Reiter Instanz landen
    // und nicht am Seitenanfang. Das geht nur, wenn der Reiter adressierbar
    // ist.
    setFetchReady();
    open();

    const bar = within(
      await screen.findByRole('group', { name: 'Bereich der Organisation' }),
    );
    fireEvent.click(bar.getByRole('button', { name: 'Verlauf' }));

    await waitFor(() => expect(window.location.search).toContain('tab=history'));
  });

  it('lässt „Überblick" AUS der URL heraus — der Vorgabewert sagt nichts', async () => {
    setFetchReady();
    open('history');

    const bar = within(
      await screen.findByRole('group', { name: 'Bereich der Organisation' }),
    );
    fireEvent.click(bar.getByRole('button', { name: 'Überblick' }));

    await waitFor(() => expect(window.location.search).not.toContain('tab='));
  });

  it('NIMMT DEN REITER NICHT MIT ZURÜCK ZUR LISTE', async () => {
    // `tab` beschreibt, wo man INNERHALB dieser Organisation stand. Auf der
    // Liste bedeutet er nichts und reiste dort als unverstandener Parameter
    // mit.
    setFetchReady();
    window.history.pushState(
      {},
      '',
      `/companies/${IDENTIFIER}?search=Solawi&tab=history`,
    );
    renderWithI18n(<App />);

    const back = await screen.findByRole('link', {
      name: /Zu allen Organisationen/,
    });
    expect(back.getAttribute('href')).toContain('search=Solawi');
    expect(back.getAttribute('href')).not.toContain('tab=');
  });

  it('zeigt den Inhalt eines Reiters erst, wenn er offen ist', async () => {
    // Sonst wäre die Umstellung reine Zierde: Alle neun Karten stünden
    // weiterhin untereinander, nur mit einer Leiste darüber.
    setFetchReady();
    open();

    await screen.findByRole('group', { name: 'Bereich der Organisation' });
    expect(screen.queryByText('Kontaktdaten löschen')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Datenschutz' }));
    expect(
      await screen.findByRole('heading', { name: 'Kontaktdaten löschen' }),
    ).toBeInTheDocument();
  });
});
