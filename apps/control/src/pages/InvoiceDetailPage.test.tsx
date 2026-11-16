import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithI18n } from '../test-support/render-with-i18n';
import App from '../App';
import type { PriceSuggestion, Invoice } from '../lib/api';

/**
 * Die Rechnungsseite — geprüft an dem, was fachlich trägt.
 *
 * Vier Dinge stehen im Mittelpunkt, weil sie im Vertrag ausdrücklich stehen:
 * Der Preisvorschlag wird nie automatisch übernommen (R5); JEDER unumkehrbare
 * Schritt — Festschreiben, Stornieren, Versenden, Erinnern — läuft erst ohne
 * Nachweis und fragt erst nach, wenn der Server ihn verlangt; eine
 * festgeschriebene Rechnung hat weder Bearbeiten- noch Löschweg, geprüft als
 * ABWESENHEIT; und das Storno-Paar ist auf beiden Seiten sichtbar.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const DRAFT_ID = 'r-draft';
const FINALIZED_ID = 'r-finalized';
const CANCELLATION_ID = 'r-cancellation';

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
  id: ORG,
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
  contactEmail: 'lena@example.com',
  contactPhone: null,
  contactRole: null,
  deputyName: null,
  deputyEmail: null,
  deputyPhone: null,
  deputyRole: null,
  status: 'paying',
  lastStatusChangeAt: '2026-05-01',
  priceTier: 'Standard',
  paymentInterval: 'monthly',
  paymentMethod: 'direct_debit',
  paymentDetailsStored: true,
  pilotDecisionDate: null,
  reviewDueDate: null,
  reviewDoneAt: null,
  instanceStartDate: '2026-01-01',
  newsletterConsentStatus: null,
  source: null,
  notes: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const SUGGESTION: PriceSuggestion = {
  tier: {
    key: 'standard',
    label: 'Standardpaket',
    untilPersons: 50,
    monthlyCent: 49000,
    halfYearlyCent: 279000,
    yearlyCent: 539000,
    setupCent: 90000,
  },
  blockers: [],
  averageActivePersons: 34,
  measurementDays: 88,
  period: { from: '2026-06-02', until: '2026-08-30' },
  customAmount: null,
  subscriptionCalculableFrom: '2026-04-01',
  subscriptionCalculable: true,
  setupCalculable: true,
};

const DRAFT: Invoice = {
  id: DRAFT_ID,
  companyId: ORG,
  companyName: 'Kollektiv Grünspecht e. V.',
  introduction: null,
  paymentNote: null,
  internalNote: null,
  invoiceNumber: null,
  status: 'draft',
  paymentState: 'draft',
  invoiceDate: '2026-08-31',
  servicePeriodFrom: '2026-08-01',
  servicePeriodUntil: '2026-08-31',
  dueDate: '2026-09-14',
  finalizedAt: null,
  createdAt: '2026-08-31T08:00:00.000Z',
  paymentDate: null,
  paidAmount: null,
  openAmount: '583.10',
  sumNet: '490.00',
  sumTax: '93.10',
  sumGross: '583.10',
  sumGrossCent: 58310,
  cancellationInvoiceId: null,
  cancelledInvoiceId: null,
  cancellationReason: null,
  isCancellation: false,
  recipientName: 'Solawi Rheintal',
  recipientAddress: 'Hauptstraße 12\n79098 Freiburg\nDeutschland',
  recipientEmail: 'lena@example.com',
  transferStatus: null,
  documentPresent: false,
  lines: [
    {
      id: 'p1',
      label: 'Standardpaket',
      description: null,
      unit: null,
      periodFrom: null,
      periodUntil: null,
      quantity: '1.000',
      unitPriceNet: '490.00',
      taxRate: '19.00',
      netAmount: '490.00',
      taxAmount: '93.10',
      grossAmount: '583.10',
    },
  ],
};

const FINALIZED: Invoice = {
  ...DRAFT,
  id: FINALIZED_ID,
  invoiceNumber: '2026-014',
  status: 'finalized',
  paymentState: 'open',
  finalizedAt: '2026-08-31T09:15:00.000Z',
};

const CANCELLATION_INVOICE: Invoice = {
  ...FINALIZED,
  id: CANCELLATION_ID,
  invoiceNumber: '2026-018',
  paymentState: 'open',
  cancelledInvoiceId: FINALIZED_ID,
  cancellationInvoiceId: null,
  cancellationReason: 'Falscher Leistungszeitraum',
  isCancellation: true,
  sumNet: '-490.00',
  sumTax: '-93.10',
  sumGross: '-583.10',
  sumGrossCent: -58310,
};

interface Options {
  invoice?: Invoice;
  list?: Invoice[];
  company?: Record<string, unknown>;
  finalizeError?: { code: string; message: string; detail?: unknown };
  /** Wie oft der Zahlungsendpunkt mit 401 antwortet, bevor er durchlässt. */
  paymentNeeds2fa?: boolean;
  /**
   * Antwortet der `RechnungAbschlussController` ohne Nachweis mit 401?
   *
   * Genau das tut er ausserhalb des Frische-Fensters von zehn Minuten — mit
   * `anmeldung_fehlgeschlagen`, gemessen gegen die echten Guards. Vorgabe hier
   * ist `false`, damit alle Altfälle den Weg der frischen Sitzung prüfen.
   */
  completeNeeds2fa?: boolean;
}

/** Die 401-Antwort des `ZweitfaktorGuard`, im Wortlaut des Servers. */
const EVIDENCE_REQUIRED = new Response(
  JSON.stringify({
    error: {
      code: 'login_failed',
      message:
        'Für diese Aktion ist das aktuelle Passwort oder ein Bestätigungscode nötig.',
    },
  }),
  { status: 401 },
);

function setFetchReady(options: Options = {}) {
  const invoice = options.invoice ?? DRAFT;
  const called = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (path.includes('/api/auth/csrf')) {
      return new Response(JSON.stringify({ csrfToken: 'abc' }), { status: 200 });
    }
    if (path.includes('/api/auth/me')) {
      return new Response(JSON.stringify(STATE), { status: 200 });
    }
    if (path.includes('/api/notes')) {
      return new Response(JSON.stringify({ notes: [] }), { status: 200 });
    }
    if (path.includes('/price-suggestion')) {
      return new Response(JSON.stringify(SUGGESTION), { status: 200 });
    }
    const withEvidence =
      body['currentPassword'] !== undefined ||
      body['totpCode'] !== undefined;
    const completeBlocks =
      (options.completeNeeds2fa ?? false) && !withEvidence;

    if (path.includes('/finalize')) {
      // Reihenfolge wie am Server: erst der Guard, dann die Fachprüfung. Nur
      // so entsteht der Fall aus [K2] — Nachweis richtig, Aufruf trotzdem
      // gescheitert.
      if (completeBlocks) return EVIDENCE_REQUIRED.clone();
      if (options.finalizeError) {
        return new Response(
          JSON.stringify({ error: options.finalizeError }),
          { status: 422 },
        );
      }
      return new Response(JSON.stringify(FINALIZED), { status: 200 });
    }
    if (path.includes('/cancel')) {
      if (completeBlocks) return EVIDENCE_REQUIRED.clone();
      return new Response(
        JSON.stringify({
          original: {
            ...FINALIZED,
            paymentState: 'cancelled',
            status: 'cancelled',
            cancellationInvoiceId: CANCELLATION_ID,
          },
          cancellation: CANCELLATION_INVOICE,
        }),
        { status: 201 },
      );
    }
    if (path.includes('/send') || path.includes('/reminder')) {
      if (completeBlocks) return EVIDENCE_REQUIRED.clone();
      return new Response(
        JSON.stringify({ ...FINALIZED, status: 'sent' }),
        { status: 200 },
      );
    }
    if (path.includes('/payment')) {
      if ((options.paymentNeeds2fa ?? true) && !withEvidence) {
        return new Response(
          JSON.stringify({
            // Der echte Code des `SecondFactorGuard` (nicht ein erfundener): die
            // Oberfläche entscheidet am Code, nicht am Status.
            error: { code: 'login_failed', message: 'Nachweis erforderlich.' },
          }),
          { status: 401 },
        );
      }
      return new Response(
        JSON.stringify({
          ...FINALIZED,
          paymentState: 'paid',
          status: 'paid',
          paidAmount: '583.10',
          paymentDate: '2026-09-01',
          openAmount: '0.00',
        }),
        { status: 200 },
      );
    }
    if (path.includes('/draft') && method === 'DELETE') {
      return new Response(JSON.stringify({ deleted: true }), { status: 200 });
    }
    if (path.includes('/draft') && method === 'PATCH') {
      return new Response(JSON.stringify(DRAFT), { status: 200 });
    }
    if (path.includes('/invoices') && method === 'POST') {
      return new Response(JSON.stringify(DRAFT), { status: 201 });
    }
    if (path.includes(`/api/invoices/${CANCELLATION_ID}`)) {
      return new Response(JSON.stringify(CANCELLATION_INVOICE), { status: 200 });
    }
    if (path.includes('/api/invoices/')) {
      return new Response(JSON.stringify(invoice), { status: 200 });
    }
    if (path.includes('/invoices')) {
      return new Response(JSON.stringify(options.list ?? []), { status: 200 });
    }
    if (path.includes('/instance')) {
      return new Response('null', { status: 200 });
    }
    if (path.includes('/api/companies/')) {
      return new Response(
        JSON.stringify(options.company ?? COMPANY),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', called);
  return called;
}

function open(invoiceId: string) {
  window.history.pushState(
    {},
    '',
    `/companies/${ORG}/invoices/${invoiceId}`,
  );
  renderWithI18n(<App />);
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('Rechnungsentwurf — R5: der Vorschlag ist ein Klick, kein Autofill', () => {
  it('füllt aus dem Preisvorschlag NICHTS von selbst in die Posten', async () => {
    setFetchReady();
    open('new');

    // Der Vorschlag ist da …
    expect(await screen.findByText('Standardpaket')).toBeInTheDocument();
    // … und die Postenzeile ist trotzdem leer.
    expect(screen.getByLabelText('Bezeichnung')).toHaveValue('');
    expect(screen.getByLabelText('Einzelpreis netto (EUR)')).toHaveValue(null);
  });

  it('legt erst auf den ausdrücklichen Klick einen Posten an — mit Betrag', async () => {
    setFetchReady();
    open('new');

    fireEvent.click(
      await screen.findByRole('button', {
        name: /Monatlichen Betrag übernehmen/,
      }),
    );

    expect(screen.getByLabelText('Bezeichnung')).toHaveValue('Standardpaket');
    expect(screen.getByLabelText('Einzelpreis netto (EUR)')).toHaveValue(490);
  });

  it('zeigt die Beträge des Vorschlags deutsch, nicht als Punkt-Zahl', async () => {
    setFetchReady();
    open('new');

    const button = await screen.findByRole('button', {
      name: /Monatlichen Betrag übernehmen/,
    });
    expect(button.textContent?.replace(/ /g, ' ')).toContain('490,00 €');
    expect(button.textContent).not.toContain('49000');
  });

  it('rechnet die Vorschau wie das Backend: 490,00 € plus 19 % ergibt 583,10 €', async () => {
    setFetchReady();
    open('new');

    fireEvent.click(
      await screen.findByRole('button', {
        name: /Monatlichen Betrag übernehmen/,
      }),
    );

    await waitFor(() => {
      expect(
        screen.getAllByText((text) => text.replace(/ /g, ' ') === '583,10 €')
          .length,
      ).toBeGreaterThan(0);
    });
  });
});

describe('Festschreiben — unumkehrbar, deshalb Wort UND zweiter Faktor', () => {
  it('hält den Knopf gesperrt, bis das Wort getippt ist', async () => {
    setFetchReady({ invoice: DRAFT });
    open(DRAFT_ID);

    fireEvent.click(await screen.findByRole('button', { name: 'Festschreiben …' }));

    const button = await screen.findByRole('button', { name: 'Jetzt festschreiben' });
    expect(button).toBeDisabled();

    fireEvent.change(
      screen.getByLabelText('Zur Bestätigung „festschreiben" eingeben'),
      { target: { value: 'festschreiben' } },
    );
    expect(button).toBeEnabled();
  });

  it('speichert vorher — aber STILL, damit kein Toast über der Fußleiste liegt', async () => {
    // Gemessen bei 375 x 700 px im Browser: Der Toast steht `fixed bottom-4
    // right-4` und wird nach dem Dialog in den Baum gehängt. Bei einem
    // Fenster, das kürzer ist als der Dialog, lag er vollständig über
    // „Jetzt festschreiben" — `elementFromPoint` traf an allen drei Punkten
    // den Toast, der Klick ging ins Leere. In jsdom liegt nichts übereinander;
    // prüfbar ist hier deshalb die Ursache: Es darf kein Toast erscheinen.
    const called = setFetchReady({ invoice: DRAFT });
    open(DRAFT_ID);

    fireEvent.click(await screen.findByRole('button', { name: 'Festschreiben …' }));
    await screen.findByRole('dialog');

    // Gespeichert wurde trotzdem — die Vorschau zeigt den Serverstand.
    expect(
      called.mock.calls.some(
        ([path, init]) =>
          String(path).includes('/draft') &&
          (init?.method ?? '').toUpperCase() === 'PATCH',
      ),
    ).toBe(true);
    expect(screen.queryByText('Entwurf gespeichert.')).toBeNull();
  });

  it('meldet das Speichern weiterhin, wenn es ausdrücklich verlangt wurde', async () => {
    setFetchReady({ invoice: DRAFT });
    open(DRAFT_ID);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Speichern' }),
    );
    expect(await screen.findByText('Entwurf gespeichert.')).toBeInTheDocument();
  });

  it('hebt genau die drei Angaben hervor, bei denen man sich vertippt', async () => {
    setFetchReady({ invoice: DRAFT });
    open(DRAFT_ID);

    fireEvent.click(await screen.findByRole('button', { name: 'Festschreiben …' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText('Bitte noch einmal prüfen')).toBeInTheDocument();
    expect(within(dialog).getByText('Leistungszeitraum')).toBeInTheDocument();
    expect(within(dialog).getByText('Posten (Stufe/Betrag)')).toBeInTheDocument();
    expect(within(dialog).getByText('Empfängeranschrift')).toBeInTheDocument();
    // Das Datum steht dd.mm.yyyy da, nie als ISO-Zeichenkette.
    expect(within(dialog).getByText(/01\.08\.2026 – 31\.08\.2026/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/2026-08-01/)).not.toBeInTheDocument();
  });

  it('fragt bei frischer Sitzung nicht nach Passwort oder Code', async () => {
    const called = setFetchReady({ invoice: DRAFT });
    open(DRAFT_ID);

    fireEvent.click(await screen.findByRole('button', { name: 'Festschreiben …' }));
    fireEvent.change(
      await screen.findByLabelText('Zur Bestätigung „festschreiben" eingeben'),
      { target: { value: 'festschreiben' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt festschreiben' }));

    await waitFor(() => {
      expect(
        called.mock.calls.some(([path]) =>
          String(path).includes('/finalize'),
        ),
      ).toBe(true);
    });
    expect(
      screen.queryByLabelText('Aktuelles Passwort'),
    ).not.toBeInTheDocument();
  });

  it('nennt die fehlenden Pflichtangaben und sagt, wo sie hingehören', async () => {
    setFetchReady({
      invoice: DRAFT,
      finalizeError: {
        code: 'invoice_incomplete',
        message: 'Der Rechnung fehlen Pflichtangaben.',
        detail: { missingDetails: ['Umsatzsteuer-Identifikationsnummer'] },
      },
    });
    open(DRAFT_ID);

    fireEvent.click(await screen.findByRole('button', { name: 'Festschreiben …' }));
    fireEvent.change(
      await screen.findByLabelText('Zur Bestätigung „festschreiben" eingeben'),
      { target: { value: 'festschreiben' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt festschreiben' }));

    expect(
      await screen.findByText('Umsatzsteuer-Identifikationsnummer'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/fehlen an deinen Firmendaten, nicht an dieser Rechnung/),
    ).toBeInTheDocument();
    // Der Dialog bleibt offen — die Liste wäre sonst weg.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

/** Öffnet ein Menü der Aktionsleiste (Herunterladen, Weitere Aktionen). */
async function openMenu(name: RegExp): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name }));
  return screen.findByRole('menu');
}

describe('Die festgeschriebene Rechnung — kein Weg, der ändert oder löscht', () => {
  it('bietet weder Bearbeiten noch Löschen an (geprüft als Abwesenheit)', async () => {
    setFetchReady({ invoice: FINALIZED });
    open(FINALIZED_ID);

    // Seit dem Redesign steht die Nummer in der ÜBERSCHRIFT („Rechnung
    // 2026-014"), nicht mehr als eigenes Textstück. Die Rolle zu prüfen ist
    // die schärfere Zusage: die Nummer benennt die Seite.
    expect(
      await screen.findByRole('heading', { name: 'Rechnung 2026-014' }),
    ).toBeInTheDocument();
    for (const forbidden of [
      /bearbeiten/i,
      /^Löschen$/,
      /Entwurf löschen/,
      /^Speichern$/,
      /Festschreiben/,
    ]) {
      expect(screen.queryByRole('button', { name: forbidden })).toBeNull();
    }
    expect(screen.queryByLabelText('Bezeichnung')).toBeNull();
  });

  it('legt Download-Varianten ins Menü „Herunterladen" — mit erklärendem Satz', async () => {
    setFetchReady({ invoice: FINALIZED });
    open(FINALIZED_ID);

    // Vorher: drei fast gleiche Knöpfe. Jetzt EIN Knopf, die Varianten dahinter.
    expect(
      await screen.findByRole('button', { name: /Herunterladen/ }),
    ).toHaveAttribute('aria-haspopup', 'menu');
    expect(screen.queryByRole('link', { name: /PDF \(ZUGFeRD\)/ })).toBeNull();

    const menu = await openMenu(/Herunterladen/);
    expect(
      within(menu).getByRole('menuitem', { name: /PDF \(ZUGFeRD\)/ }),
    ).toHaveAttribute('href', `/api/invoices/${FINALIZED_ID}/document`);
    expect(
      within(menu).getByRole('menuitem', { name: /ZUGFeRD-XML/ }),
    ).toHaveAttribute('href', `/api/invoices/${FINALIZED_ID}/xml`);
    expect(
      within(menu).getByRole('menuitem', { name: /XRechnung \(XML\)/ }),
    ).toHaveAttribute('href', `/api/invoices/${FINALIZED_ID}/xrechnung`);
    expect(
      within(menu).getByText(/PDF mit eingebetteter Rechnungsdatei \(ZUGFeRD\), für Unternehmen/),
    ).toBeInTheDocument();
    expect(within(menu).getByText(/für Behörden/)).toBeInTheDocument();
  });

  it.each([
    ['authority', ['XRechnung (XML)', 'PDF (ZUGFeRD)', 'ZUGFeRD-XML']],
    ['business', ['PDF (ZUGFeRD)', 'XRechnung (XML)', 'ZUGFeRD-XML']],
    ['consumer', ['PDF (ZUGFeRD)', 'XRechnung (XML)', 'ZUGFeRD-XML']],
  ] as const)(
    'Download-Reihenfolge bei %s: empfohlene Variante oben und markiert',
    async (buyerType, expected) => {
      setFetchReady({
        invoice: { ...FINALIZED, recipientBuyerType: buyerType },
      });
      open(FINALIZED_ID);

      const menu = await openMenu(/Herunterladen/);
      const items = within(menu).getAllByRole('menuitem');
      expect(items.map((i) => i.querySelector('span')?.firstChild?.textContent)).toEqual(
        expected,
      );
      // Nur die erste ist markiert.
      expect(within(items[0] as HTMLElement).getByText('Empfohlen')).toBeInTheDocument();
      expect(within(menu).getAllByText('Empfohlen')).toHaveLength(1);
      // Der alte Hinweis unter dem Knopf entfällt.
      expect(screen.queryByText(/Behörde: Bitte die XRechnung/)).toBeNull();
    },
  );

  it('ohne bekannte Empfängerart gibt es keine Empfehlung', async () => {
    setFetchReady({ invoice: { ...FINALIZED, recipientBuyerType: null } });
    open(FINALIZED_ID);

    const menu = await openMenu(/Herunterladen/);
    expect(within(menu).queryByText('Empfohlen')).toBeNull();
  });

  it('zeigt genau die erlaubten Handlungen', async () => {
    setFetchReady({ invoice: FINALIZED });
    open(FINALIZED_ID);

    expect(await screen.findByRole('button', { name: /^Versenden$/ })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Zahlung erfassen/ }),
    ).toBeInTheDocument();
    // Stornieren liegt im Menü „Weitere", nicht als eigener Knopf daneben.
    expect(screen.queryByRole('button', { name: /^Stornieren/ })).toBeNull();
    const menu = await openMenu(/Weitere Aktionen/);
    expect(
      within(menu).getByRole('menuitem', { name: /Stornieren/ }),
    ).toBeInTheDocument();
  });

  it('steht die Aktionsleiste in der Kopfzeile, vor der Integritätskarte', async () => {
    setFetchReady({ invoice: FINALIZED });
    open(FINALIZED_ID);

    const bar = await screen.findByRole('group', { name: 'Aktionen zur Rechnung' });
    const heading = screen.getByRole('heading', { name: 'Rechnung 2026-014' });
    const integrity = screen.getByText('Integrität und Aufbewahrung');
    expect(
      heading.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      bar.compareDocumentPosition(integrity) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  describe('genau eine Hauptaktion je Status', () => {
    /** Die Knöpfe der Leiste, die als Hauptaktion (primär) gestaltet sind. */
    function primaryButtons(): string[] {
      const bar = screen.getByRole('group', { name: 'Aktionen zur Rechnung' });
      return within(bar)
        .getAllByRole('button')
        .filter((b) => b.className.includes('bg-primaer '))
        .map((b) => b.textContent?.trim() ?? '');
    }

    it('festgeschrieben und nie versendet: „Versenden"', async () => {
      setFetchReady({ invoice: FINALIZED });
      open(FINALIZED_ID);
      await screen.findByRole('group', { name: 'Aktionen zur Rechnung' });
      expect(primaryButtons()).toEqual(['Versenden']);
    });

    it.each(['open', 'overdue', 'partially_paid'] as const)(
      'versendet und %s: „Zahlung erfassen", Versand nur sekundär',
      async (paymentState) => {
        setFetchReady({
          invoice: { ...FINALIZED, status: 'sent', paymentState },
        });
        open(FINALIZED_ID);
        await screen.findByRole('group', { name: 'Aktionen zur Rechnung' });
        expect(primaryButtons()).toEqual(['Zahlung erfassen']);
        expect(
          screen.getByRole('button', { name: /Erneut versenden/ }),
        ).toBeInTheDocument();
      },
    );

    it('bezahlt: keine Hauptaktion, kein Zahlungsknopf', async () => {
      setFetchReady({
        invoice: { ...FINALIZED, status: 'paid', paymentState: 'paid' },
      });
      open(FINALIZED_ID);
      await screen.findByRole('group', { name: 'Aktionen zur Rechnung' });
      expect(primaryButtons()).toEqual([]);
      expect(screen.queryByRole('button', { name: /Zahlung erfassen/ })).toBeNull();
    });

    it('Zahlungserinnerung bleibt ein Nebenknopf (überfällig)', async () => {
      setFetchReady({
        invoice: { ...FINALIZED, status: 'sent', paymentState: 'overdue' },
      });
      open(FINALIZED_ID);
      await screen.findByRole('group', { name: 'Aktionen zur Rechnung' });
      expect(primaryButtons()).toEqual(['Zahlung erfassen']);
      expect(
        screen.getByRole('button', { name: /Zahlungserinnerung senden/ }),
      ).toBeInTheDocument();
    });
  });

  it('ZEIGT DIE MELDUNG DES SERVERS, statt einen Tab mit rohem JSON zu oeffnen', async () => {
    // Am 31.08.2026 gemessen: Der Rechnungsdienst lief nicht, und wer auf
    // „PDF (ZUGFeRD)" klickte, sah
    //   {"fehler":{"code":"rechnungsdienst_nicht_erreichbar",…}}
    // in einem neuen Tab. Die Meldung darin ist für Menschen geschrieben —
    // sie stand nur an einer Stelle, an der sie niemand lesen soll.
    setFetchReady({ invoice: FINALIZED });
    open(FINALIZED_ID);

    const menu = await openMenu(/Herunterladen/);
    const reference = within(menu).getByRole('menuitem', {
      name: /PDF \(ZUGFeRD\)/,
    });

    // Der Verweis BLEIBT ein echter href — Mittelklick und „Link kopieren"
    // sollen weiter funktionieren.
    //
    // WAS DIESER TEST NICHT ABDECKT: dass der Klick die Navigation wirklich
    // unterbindet. jsdom folgt einem href ohnehin nicht, und `preventDefault`
    // ist hier deshalb nicht beobachtbar — die Gegenprobe (Zeile entfernt)
    // liess den Test gruen. Was er belegt, ist das Entscheidende und war der
    // gemeldete Fehler: dass die Meldung des Servers IM PROGRAMM ankommt.
    // Ohne den onClick-Handler wird er rot, nachgeprueft.
    expect(reference).toHaveAttribute(
      'href',
      `/api/invoices/${FINALIZED_ID}/document`,
    );

    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'invoice_service_not_reachable',
              message:
                'Der Rechnungsdienst hat nicht geantwortet. Die Rechnung ' +
                'bleibt bestehen; das Dokument lässt sich später nachziehen.',
            },
          }),
          { status: 502, headers: { 'content-type': 'application/json' } },
        ),
    ) as typeof globalThis.fetch;

    try {
      fireEvent.click(reference);
      expect(
        await screen.findByText(/Der Rechnungsdienst hat nicht geantwortet/),
      ).toBeInTheDocument();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('zeigt Menge und Steuersatz deutsch — „1.000" heißt EINS, nicht tausend', async () => {
    // Der Server liefert `menge: "1.000"` (Decimal(10,3)) und
    // `steuersatz: "19.00"`. Roh gerendert läse man in der Mengenspalte
    // „1.000" — deutsch also tausend, direkt neben Einzelpreis und
    // Gesamtbetrag. Der Fund stammt aus der Browser-Messung bei 375 px, nicht
    // aus der Spezifikation.
    setFetchReady({ invoice: FINALIZED });
    open(FINALIZED_ID);

    const row = (await screen.findByText('Standardpaket')).closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('1')).toBeInTheDocument();
    expect(within(row as HTMLElement).queryByText('1.000')).toBeNull();
    expect(
      within(row as HTMLElement).getByText((t) => t.replace(/\u00a0/g, ' ') === '19 %'),
    ).toBeInTheDocument();
    expect(within(row as HTMLElement).queryByText(/19\.00/)).toBeNull();
  });

  it('zeigt den abgeleiteten Zahlungsstand, nicht die rohe Statusspalte', async () => {
    setFetchReady({ invoice: FINALIZED });
    open(FINALIZED_ID);

    expect(await screen.findByText('Offen')).toBeInTheDocument();
    expect(screen.queryByText('Festgeschrieben')).toBeNull();
  });
});

describe('Storno — das Paar, nicht das Löschen', () => {
  it('verlangt einen Grund und führt danach auf die Stornorechnung', async () => {
    setFetchReady({ invoice: FINALIZED });
    open(FINALIZED_ID);

    fireEvent.click(
      within(await openMenu(/Weitere Aktionen/)).getByRole('menuitem', { name: /Stornieren/ }),
    );
    const button = await screen.findByRole('button', {
      name: 'Rechnung stornieren',
    });
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Grund'), {
      target: { value: 'Falscher Leistungszeitraum' },
    });
    expect(button).toBeEnabled();
    fireEvent.click(button);

    expect(
      await screen.findByRole('heading', { name: 'Rechnung 2026-018' }),
    ).toBeInTheDocument();
    // Die kanonische Form: Eine Rechnung ist ein Gegenstand für sich.
    expect(window.location.pathname).toBe(`/invoices/${CANCELLATION_ID}`);
  });

  it('stellt auf der Stornorechnung den Verweis auf das Original daneben', async () => {
    setFetchReady({ invoice: CANCELLATION_INVOICE });
    open(CANCELLATION_ID);

    expect(
      await screen.findByText(/Diese Rechnung storniert/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Beide Belege bleiben bestehen — gelöscht wurde nichts\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/Falscher Leistungszeitraum/)).toBeInTheDocument();
  });

  it('bietet an einer Stornorechnung kein zweites Stornieren an', async () => {
    setFetchReady({ invoice: CANCELLATION_INVOICE });
    open(CANCELLATION_ID);

    await screen.findByRole('heading', { name: 'Rechnung 2026-018' });
    expect(screen.queryByRole('button', { name: /Stornieren/ })).toBeNull();
    // Auch das Menü „Weitere" entfällt: Es hätte nichts zu zeigen.
    expect(screen.queryByRole('button', { name: /Weitere Aktionen/ })).toBeNull();
  });
});

describe('Zahlung — hinter dem zweiten Faktor', () => {
  it('ruft erst ohne Nachweis und fragt erst bei 401 nach', async () => {
    const called = setFetchReady({ invoice: FINALIZED });
    open(FINALIZED_ID);

    fireEvent.click(await screen.findByRole('button', { name: /Zahlung erfassen/ }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Zahlung erfassen' }),
    );

    // Der Nachweis-Dialog klappt auf, weil der Server 401 geantwortet hat.
    fireEvent.change(await screen.findByLabelText('Aktuelles Passwort'), {
      target: { value: 'geheim' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    await waitFor(() => {
      const paymentCalls = called.mock.calls.filter(([path]) =>
        String(path).includes('/payment'),
      );
      expect(paymentCalls).toHaveLength(2);
      expect(String(paymentCalls[0]?.[1]?.body)).not.toContain(
        'currentPassword',
      );
      expect(String(paymentCalls[1]?.[1]?.body)).toContain('currentPassword');
    });
  });

  it('schickt bei „Voll bezahlt“ (Vorauswahl) die ganze Rechnungssumme in Cent', async () => {
    const called = setFetchReady({ invoice: FINALIZED });
    open(FINALIZED_ID);

    fireEvent.click(await screen.findByRole('button', { name: /Zahlung erfassen/ }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('radio', { name: /Voll bezahlt/ }),
    ).toBeChecked();
    // Das Betragsfeld gibt es erst bei „Teilzahlung“.
    expect(within(dialog).queryByLabelText('Betrag dieser Zahlung (EUR)')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Zahlung erfassen' }));

    await waitFor(() => {
      const first = called.mock.calls.find(([path]) =>
        String(path).includes('/payment'),
      );
      expect(JSON.parse(String(first?.[1]?.body))).toMatchObject({
        paidAmountCent: 58310,
      });
    });
  });

  it('rechnet eine Teilzahlung auf den kumulierten Gesamtstand um, ohne Gleitkomma', async () => {
    const called = setFetchReady({ invoice: FINALIZED });
    open(FINALIZED_ID);

    fireEvent.click(await screen.findByRole('button', { name: /Zahlung erfassen/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: /Teilzahlung/ }));
    expect(within(dialog).getByText(/Bisher bezahlt:/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Betrag dieser Zahlung (EUR)'), {
      target: { value: '19.99' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Zahlung erfassen' }));

    await waitFor(() => {
      const first = called.mock.calls.find(([path]) =>
        String(path).includes('/payment'),
      );
      // Nichts bisher bezahlt: Gesamtstand = diese Zahlung.
      expect(JSON.parse(String(first?.[1]?.body))).toMatchObject({
        paidAmountCent: 1999,
      });
    });
  });
});

/**
 * ===========================================================================
 * [K3] DER ZWEITE FAKTOR SASS AN DER FALSCHEN STELLE
 * ===========================================================================
 *
 * Gemessen mit einem selbst signierten, eine Stunde alten Sitzungs-Cookie:
 * `FESTSCHREIBEN 200 → 2026-078`, `STORNIEREN 201 → 2026-079`,
 * `ZAHLUNG 401`. Das Backend hat das umgedreht; diese Tests halten die
 * Oberfläche dagegen. Sie prüfen NICHT „ein Dialog erscheint" — das wäre
 * beliebig —, sondern die Abfolge, auf die es ankommt: erst ein Aufruf OHNE
 * Nachweis, dann genau einer MIT.
 */
describe('[K3] Der Abschluss einer Rechnung — hinter dem zweiten Faktor', () => {
  /**
   * Führt den Nachweis-Dialog aus — und prüft dabei, dass er der OBERSTE ist.
   *
   * Beim Festschreiben und beim Stornieren steht bereits ein Dialog offen,
   * wenn dieser aufgeht. Beide Overlays tragen `z-50`; welcher oben liegt,
   * entscheidet allein die DOM-Reihenfolge. Der Nachweis-Dialog muss der
   * LETZTE sein, sonst liegt die Fußleiste des Bestätigungsdialogs über dem
   * Passwortfeld — genau der Fehler, der in dieser Anwendung bei 375 × 700 px
   * schon zweimal aufgetreten ist. In jsdom liegt nichts übereinander,
   * prüfbar ist deshalb die Ursache: die Reihenfolge.
   */
  async function evidenceKeep(explanation: RegExp) {
    // Erst auf den Begründungssatz warten — er ist je Handlung ein anderer und
    // erscheint erst, wenn der Nachweis-Dialog wirklich aufgegangen ist.
    // (`findAllByRole('dialog')` käme zu früh zurück: Beim Festschreiben und
    // beim Stornieren steht schon einer offen.)
    const sentence = await screen.findByText(explanation);
    const dialogs = screen.getAllByRole('dialog');
    const top = dialogs[dialogs.length - 1] as HTMLElement;
    expect(top.contains(sentence)).toBe(true);
    fireEvent.change(
      within(top).getByLabelText('Aktuelles Passwort'),
      { target: { value: 'geheim' } },
    );
    fireEvent.click(within(top).getByRole('button', { name: 'Weiter' }));
  }

  function callsTo(
    called: ReturnType<typeof setFetchReady>,
    partial: string,
  ) {
    return called.mock.calls.filter(([path]) => String(path).includes(partial));
  }

  it('festschreiben: erst ohne Nachweis, nach 401 mit Nachweis', async () => {
    const called = setFetchReady({
      invoice: DRAFT,
      completeNeeds2fa: true,
    });
    open(DRAFT_ID);

    fireEvent.click(await screen.findByRole('button', { name: 'Festschreiben …' }));
    fireEvent.change(
      await screen.findByLabelText('Zur Bestätigung „festschreiben" eingeben'),
      { target: { value: 'festschreiben' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt festschreiben' }));

    await evidenceKeep(/Rechnungsnummer, die nie wieder frei wird/);

    await waitFor(() => {
      const call = callsTo(called, '/finalize');
      expect(call).toHaveLength(2);
      expect(String(call[0]?.[1]?.body)).not.toContain('currentPassword');
      expect(String(call[1]?.[1]?.body)).toContain('currentPassword');
      // Das getippte Wort bleibt — der Faktor ERSETZT es nicht.
      expect(String(call[1]?.[1]?.body)).toContain('festschreiben');
    });
  });

  it('stornieren: erst ohne Nachweis, nach 401 mit Nachweis', async () => {
    const called = setFetchReady({
      invoice: FINALIZED,
      completeNeeds2fa: true,
    });
    open(FINALIZED_ID);

    fireEvent.click(
      within(await openMenu(/Weitere Aktionen/)).getByRole('menuitem', { name: /Stornieren/ }),
    );
    fireEvent.change(await screen.findByLabelText('Grund'), {
      target: { value: 'Falscher Leistungszeitraum' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rechnung stornieren' }));

    await evidenceKeep(/hebt die Forderung endgültig auf/);

    await waitFor(() => {
      const call = callsTo(called, '/cancel');
      expect(call).toHaveLength(2);
      expect(String(call[0]?.[1]?.body)).not.toContain('currentPassword');
      expect(String(call[1]?.[1]?.body)).toContain('currentPassword');
      expect(String(call[1]?.[1]?.body)).toContain('Falscher Leistungszeitraum');
    });
  });

  it('versenden: erst ohne Nachweis, nach 401 mit Nachweis', async () => {
    const called = setFetchReady({
      invoice: FINALIZED,
      completeNeeds2fa: true,
    });
    open(FINALIZED_ID);

    fireEvent.click(await screen.findByRole('button', { name: /^Versenden$/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Jetzt senden' }));
    await evidenceKeep(/verschickte Mail holt niemand zurück/);

    await waitFor(() => {
      const call = callsTo(called, '/send');
      expect(call).toHaveLength(2);
      expect(String(call[0]?.[1]?.body)).not.toContain('currentPassword');
      expect(String(call[1]?.[1]?.body)).toContain('currentPassword');
    });
  });

  it('erinnerung: erst ohne Nachweis, nach 401 mit Nachweis', async () => {
    const called = setFetchReady({
      invoice: { ...FINALIZED, paymentState: 'overdue' },
      completeNeeds2fa: true,
    });
    open(FINALIZED_ID);

    const reminder = await screen.findByRole('button', { name: /Zahlungserinnerung senden/ });
    // „Mahnung" als Zusatz in derselben Zeile — wer danach sucht, findet den Knopf.
    expect(within(reminder).getByText('(Mahnung)')).toBeInTheDocument();
    fireEvent.click(reminder);
    fireEvent.click(await screen.findByRole('button', { name: 'Erinnerung senden' }));
    await evidenceKeep(/geht an eine Kundin/);

    await waitFor(() => {
      const call = callsTo(called, '/reminder');
      expect(call).toHaveLength(2);
      expect(String(call[0]?.[1]?.body)).not.toContain('currentPassword');
      expect(String(call[1]?.[1]?.body)).toContain('currentPassword');
    });
  });

  it('sagt „Aktuelles Passwort ist falsch", statt es stumm zu wiederholen', async () => {
    // Fehlerfall: Der Server lehnt AUCH den mitgeschickten Nachweis ab. Der
    // Dialog muss offen bleiben und den Grund nennen — sonst tippt jemand ins
    // Leere und hält das Festschreiben für kaputt.
    setFetchReady({ invoice: DRAFT, completeNeeds2fa: true });
    // Der Endpunkt bleibt bei 401, auch mit Nachweis: dieselbe Attrappe,
    // aber der Nachweis wird nie akzeptiert.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes('/api/auth/csrf'))
          return new Response(JSON.stringify({ csrfToken: 'abc' }), { status: 200 });
        if (path.includes('/api/auth/me'))
          return new Response(JSON.stringify(STATE), { status: 200 });
        if (path.includes('/price-suggestion'))
          return new Response(JSON.stringify(SUGGESTION), { status: 200 });
        if (path.includes('/finalize') || path.includes('/draft'))
          return path.includes('/finalize')
            ? EVIDENCE_REQUIRED.clone()
            : new Response(JSON.stringify(DRAFT), { status: 200 });
        if (path.includes('/api/invoices/'))
          return new Response(JSON.stringify(DRAFT), { status: 200 });
        if (path.includes('/api/companies/'))
          return new Response(JSON.stringify(COMPANY), { status: 200 });
        return new Response('{}', { status: 200 });
      }),
    );
    open(DRAFT_ID);

    fireEvent.click(await screen.findByRole('button', { name: 'Festschreiben …' }));
    fireEvent.change(
      await screen.findByLabelText('Zur Bestätigung „festschreiben" eingeben'),
      { target: { value: 'festschreiben' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt festschreiben' }));
    fireEvent.change(await screen.findByLabelText('Aktuelles Passwort'), {
      target: { value: 'falsch' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    expect(
      await screen.findByText('Aktuelles Passwort ist falsch.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Aktuelles Passwort')).toBeInTheDocument();
  });
});

/**
 * [H5] Nach der Kontaktdatenlöschung geht ein Versand weiterhin an die
 * eingefrorene Schnappschussadresse. Das Aufbewahren des Schnappschusses ist
 * richtig — ein NEUER Versand dorthin ist eine weitere Verarbeitung nach dem
 * Löschverlangen. Deshalb keine Sperre, aber eine Nachfrage mit Adresse.
 */
describe('[H5] Versand nach der Kontaktdatenlöschung', () => {
  const DELETED = {
    ...COMPANY,
    name: 'Kontaktdaten gelöscht',
    contactEmail: null,
    billingEmail: null,
  };

  it('fragt vor dem Versand nach und nennt die Adresse, die getroffen würde', async () => {
    const called = setFetchReady({
      invoice: FINALIZED,
      company: DELETED,
    });
    open(FINALIZED_ID);

    fireEvent.click(await screen.findByRole('button', { name: /^Versenden$/ }));

    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/weitere Verarbeitung nach dem Löschverlangen/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('lena@example.com')).toBeInTheDocument();
    // Noch ist nichts hinausgegangen.
    expect(
      called.mock.calls.filter(([path]) => String(path).includes('/send')),
    ).toHaveLength(0);
  });

  it('bricht ab, wenn abgebrochen wird — und sendet auf ausdrücklichen Klick', async () => {
    const called = setFetchReady({
      invoice: FINALIZED,
      company: DELETED,
    });
    open(FINALIZED_ID);

    fireEvent.click(await screen.findByRole('button', { name: /^Versenden$/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Abbrechen' }));
    expect(
      called.mock.calls.filter(([path]) => String(path).includes('/send')),
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /^Versenden$/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Trotzdem senden' }));

    await waitFor(() => {
      expect(
        called.mock.calls.filter(([path]) =>
          String(path).includes('/send'),
        ),
      ).toHaveLength(1);
    });
  });

  it('fragt bei ungelöschten Kontaktdaten nur mit dem Bestätigungsdialog nach', async () => {
    const called = setFetchReady({ invoice: FINALIZED });
    open(FINALIZED_ID);

    fireEvent.click(await screen.findByRole('button', { name: /^Versenden$/ }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).queryByText(/weitere Verarbeitung nach dem Löschverlangen/),
    ).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Jetzt senden' }));

    await waitFor(() => {
      expect(
        called.mock.calls.filter(([path]) =>
          String(path).includes('/send'),
        ),
      ).toHaveLength(1);
    });
  });
});

/**
 * ===========================================================================
 * [K2] EIN FREMDER FEHLER MUSS DEN NACHWEIS-DIALOG SCHLIESSEN
 * ===========================================================================
 *
 * Der Nachweis war richtig, der Aufruf scheiterte trotzdem — an einer
 * fehlenden Pflichtangabe (422). Die Meldung dazu steht im Dialog DARUNTER.
 * Blieb der Nachweis-Dialog offen, lag er vollständig darüber: Zu sehen war
 * nur ein leeres Passwortfeld, die Antwort des Servers stand unsichtbar
 * dahinter. Derselbe Dialogstapel, in dem schon zweimal etwas verdeckt lag.
 */
describe('[K2] Der Nachweis-Dialog schließt bei einem fremden Fehler', () => {
  it('zeigt die 422-Meldung, statt sie unter dem Passwortfeld zu verstecken', async () => {
    setFetchReady({
      invoice: DRAFT,
      completeNeeds2fa: true,
      finalizeError: {
        code: 'invoice_incomplete',
        message: 'Der Rechnung fehlen Pflichtangaben.',
        detail: { missingDetails: ['Umsatzsteuer-Identifikationsnummer'] },
      },
    });
    open(DRAFT_ID);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Festschreiben …' }),
    );
    fireEvent.change(
      await screen.findByLabelText('Zur Bestätigung „festschreiben" eingeben'),
      { target: { value: 'festschreiben' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt festschreiben' }));

    // Erster Aufruf ohne Nachweis → Dialog geht auf.
    fireEvent.change(await screen.findByLabelText('Aktuelles Passwort'), {
      target: { value: 'geheim' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    // Zweiter Aufruf mit richtigem Nachweis → 422.
    expect(
      await screen.findByText('Der Rechnung fehlen Pflichtangaben.'),
    ).toBeInTheDocument();

    // ENTSCHEIDEND: Das Passwortfeld ist weg, sonst läge es darüber.
    expect(screen.queryByLabelText('Aktuelles Passwort')).toBeNull();
    // Und die Meldung steht im obersten verbliebenen Dialog, ist also sichtbar.
    const dialogs = screen.getAllByRole('dialog');
    const top = dialogs[dialogs.length - 1] as HTMLElement;
    expect(
      within(top).getByText('Der Rechnung fehlen Pflichtangaben.'),
    ).toBeInTheDocument();
  });

  it('lässt den Dialog bei einem FALSCHEN Nachweis dagegen offen', async () => {
    // Gegenprobe: Sonst wäre „schließt immer" die einfachere und falsche
    // Regel — bei falschem Passwort muss man weitertippen können.
    setFetchReady({ invoice: DRAFT, completeNeeds2fa: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes('/api/auth/csrf'))
          return new Response(JSON.stringify({ csrfToken: 'abc' }), {
            status: 200,
          });
        if (path.includes('/api/auth/me'))
          return new Response(JSON.stringify(STATE), { status: 200 });
        if (path.includes('/price-suggestion'))
          return new Response(JSON.stringify(SUGGESTION), { status: 200 });
        if (path.includes('/finalize')) return EVIDENCE_REQUIRED.clone();
        if (path.includes('/draft') || path.includes('/api/invoices/'))
          return new Response(JSON.stringify(DRAFT), { status: 200 });
        if (path.includes('/api/companies/'))
          return new Response(JSON.stringify(COMPANY), { status: 200 });
        return new Response('{}', { status: 200 });
      }),
    );
    open(DRAFT_ID);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Festschreiben …' }),
    );
    fireEvent.change(
      await screen.findByLabelText('Zur Bestätigung „festschreiben" eingeben'),
      { target: { value: 'festschreiben' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt festschreiben' }));
    fireEvent.change(await screen.findByLabelText('Aktuelles Passwort'), {
      target: { value: 'falsch' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    expect(
      await screen.findByText('Aktuelles Passwort ist falsch.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Aktuelles Passwort')).toBeInTheDocument();
  });
});

/**
 * ===========================================================================
 * [K3] DIE OBERFLÄCHE SCHICKT ZUR RICHTIGEN STELLE
 * ===========================================================================
 *
 * `fehlendePflichtangaben` prüft beide Seiten der Rechnung. Der Dialog zeigte
 * dazu immer denselben Satz: „am Aussteller … über die Server-Konfiguration
 * gepflegt." Bei „Vollständige Anschrift der Rechnungsempfängerin" war das
 * falsch — die Angabe steht an der Organisation, zwei Klicks entfernt.
 */
describe('[K3] Fehlende Pflichtangaben — wo sie gepflegt werden', () => {
  async function openWith(missingDetails: string[]) {
    setFetchReady({
      invoice: DRAFT,
      finalizeError: {
        code: 'invoice_incomplete',
        message: 'Der Rechnung fehlen Pflichtangaben.',
        detail: { missingDetails },
      },
    });
    open(DRAFT_ID);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Festschreiben …' }),
    );
    fireEvent.change(
      await screen.findByLabelText('Zur Bestätigung „festschreiben" eingeben'),
      { target: { value: 'festschreiben' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt festschreiben' }));
    await screen.findByText('Der Rechnung fehlen Pflichtangaben.');
  }

  it('schickt bei einer Empfängerangabe zur Organisation, nicht zum Server', async () => {
    await openWith([
      'Vollständige Anschrift der Rechnungsempfängerin (Straße, PLZ, Ort)',
    ]);

    expect(
      screen.getByText(/stehen an der Organisation/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Solawi Rheintal öffnen/ }),
    ).toHaveAttribute('href', `/companies/${ORG}`);
    // Der falsche Satz darf hier NICHT stehen.
    expect(screen.queryByText(/Server-Konfiguration/)).toBeNull();
  });

  it('verlinkt bei einer Ausstellerangabe direkt auf die Firmendaten', async () => {
    await openWith(['Umsatzsteuer-Identifikationsnummer']);

    expect(
      screen.getByRole('link', { name: 'Einstellungen → Firmendaten' }),
    ).toHaveAttribute('href', '/settings?tab=company');
    expect(screen.queryByText(/Server-Konfiguration/)).toBeNull();
    expect(screen.queryByRole('link', { name: /öffnen/ })).toBeNull();
  });

  it('trennt beide Seiten, wenn beides zugleich fehlt', async () => {
    await openWith([
      'Umsatzsteuer-Identifikationsnummer',
      'Name der Rechnungsempfängerin',
      'Mindestens ein Rechnungsposten',
    ]);

    expect(screen.getByText(/stehen an der Organisation/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Einstellungen → Firmendaten' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Das fehlt an dieser Rechnung/),
    ).toBeInTheDocument();
    // Alle drei Angaben stehen weiterhin da — sortiert, nicht gefiltert.
    for (const detail of [
      'Umsatzsteuer-Identifikationsnummer',
      'Name der Rechnungsempfängerin',
      'Mindestens ein Rechnungsposten',
    ]) {
      expect(screen.getByText(detail)).toBeInTheDocument();
    }
  });
});

/** [W2] Die Spezifikation verlangt alle drei Summen in der Vorschau. */
describe('[W2] Die Vorschau zeigt Netto, Steuer und Brutto', () => {
  it('nennt auch die Steuersumme', async () => {
    setFetchReady({ invoice: DRAFT });
    open(DRAFT_ID);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Festschreiben …' }),
    );
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText('Summe netto')).toBeInTheDocument();
    expect(within(dialog).getByText('Summe Steuer')).toBeInTheDocument();
    expect(within(dialog).getByText('Summe brutto')).toBeInTheDocument();
    // Deutsch formatiert, nicht als Punkt-Dezimalzahl vom Server.
    expect(
      within(dialog).getByText((t) => t.replace(/ /g, ' ') === '93,10 €'),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText('93.10')).toBeNull();
  });
});

/**
 * DER BEARBEITEN-SCHIRM — die Felder, die der Entwurf des Designs verlangt.
 *
 * Zwei Zusagen stehen hier auf dem Spiel, und beide sind heikel:
 *
 * 1. DIE NUMMER IST GESPERRT UND LEER. Eine vorläufige Nummer anzuzeigen
 *    wäre eine Zusage, die der Nummernkreis nicht hält: Er vergibt erst beim
 *    Festschreiben, und zwar nach dem Rechnungsdatum. Wer das Datum danach
 *    noch ändert, bekäme eine andere Nummer als die angezeigte.
 * 2. DIE INTERNE NOTIZ VERLÄSST DAS HAUS NICHT. Sie steht auf keinem Beleg
 *    und geht in keine Mail — die Beschriftung sagt es, und der Server hält
 *    sie aus dem Dokument heraus (geprüft in der Integrationsprobe).
 */
describe('Rechnung bearbeiten — die zweispaltige Maske', () => {
  it('HÄLT DAS NUMMERNFELD LEER UND GESPERRT, solange es Entwurf ist', async () => {
    setFetchReady({ invoice: DRAFT });
    open(DRAFT_ID);

    const field = await screen.findByLabelText('Rechnungsnummer');
    expect(field).toBeDisabled();
    expect(field).toHaveValue('');
    // Der Platzhalter sagt, WANN sie kommt — statt eine zu erfinden.
    expect(field).toHaveAttribute(
      'placeholder',
      'wird beim Festschreiben vergeben',
    );
  });

  it('zeigt die drei Textfelder mit ihrer jeweiligen Zusage', async () => {
    setFetchReady({ invoice: DRAFT });
    open(DRAFT_ID);

    // Die Texte liegen im eingeklappten Abschnitt „Texte und Notiz (optional)".
    fireEvent.click(await screen.findByRole('button', { name: /Texte und Notiz/ }));
    expect(await screen.findByLabelText('Einleitung')).toBeInTheDocument();
    expect(screen.getByLabelText('Zahlungshinweis')).toBeInTheDocument();
    const note = screen.getByLabelText('Notiz');
    expect(note).toBeInTheDocument();
    expect(
      screen.getByText('Steht auf keinem Beleg und geht in keine Mail.'),
    ).toBeInTheDocument();
  });

  it('SCHICKT die drei Texte beim Speichern mit', async () => {
    const called = setFetchReady({ invoice: DRAFT });
    open(DRAFT_ID);

    fireEvent.click(await screen.findByRole('button', { name: /Texte und Notiz/ }));
    fireEvent.change(await screen.findByLabelText('Einleitung'), {
      target: { value: 'wie besprochen die Rechnung fürs kommende Jahr.' },
    });
    fireEvent.change(screen.getByLabelText('Zahlungshinweis'), {
      target: { value: 'Bitte die Nummer im Verwendungszweck angeben.' },
    });
    fireEvent.change(screen.getByLabelText('Notiz'), {
      target: { value: 'Zahlt spät — im Oktober nachfassen.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Speichern$/ }));

    await waitFor(() => {
      const patch = called.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(patch).toBeDefined();
      const body = JSON.parse(String((patch![1] as RequestInit).body)) as Record<
        string,
        unknown
      >;
      expect(body['introduction']).toBe(
        'wie besprochen die Rechnung fürs kommende Jahr.',
      );
      expect(body['paymentNote']).toBe(
        'Bitte die Nummer im Verwendungszweck angeben.',
      );
      expect(body['internalNote']).toBe('Zahlt spät — im Oktober nachfassen.');
    });
  });

  it('SCHICKT EINEN GELEERTEN TEXT ALS LEEREN TEXT, nicht als Auslassung', async () => {
    // Wer einen Einleitungssatz wieder herausnimmt, will ihn weg haben. Das
    // Feld wegzulassen hiesse für den Server „unverändert" — der Satz bliebe
    // auf dem Beleg stehen.
    const called = setFetchReady({
      invoice: { ...DRAFT, introduction: 'Alter Satz.' },
    });
    open(DRAFT_ID);

    fireEvent.change(await screen.findByLabelText('Einleitung'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Speichern$/ }));

    await waitFor(() => {
      const patch = called.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(patch).toBeDefined();
      const body = JSON.parse(String((patch![1] as RequestInit).body)) as Record<
        string,
        unknown
      >;
      expect(body).toHaveProperty('introduction', '');
    });
  });

  it('liest Beschreibung und Einheit eines Bestandspostens wieder ein', async () => {
    // Beide gingen beim Nachbearbeiten still verloren, solange die Antwort
    // sie nicht auslieferte. Der Test hält die Wiederherstellung fest.
    setFetchReady({
      invoice: {
        ...DRAFT,
        lines: [
          {
            ...DRAFT.lines[0]!,
            description: 'Zugang für bis zu 60 Teilhabende',
            unit: 'MON',
            periodFrom: '2026-08-01',
            periodUntil: '2026-08-31',
          },
        ],
      },
    });
    open(DRAFT_ID);

    // Der Zeitraum steht OFFEN, Beschreibung und Einheit im Aufklapper.
    expect(await screen.findByLabelText('Zeitraum von')).toHaveValue('2026-08-01');
    expect(screen.getByLabelText('Zeitraum bis')).toHaveValue('2026-08-31');

    fireEvent.click(screen.getByRole('button', { name: /Weitere Angaben/ }));
    expect(screen.getByLabelText('Beschreibung')).toHaveValue(
      'Zugang für bis zu 60 Teilhabende',
    );
    expect(screen.getByLabelText('Einheit')).toHaveValue('MON');
  });

  it('WEIST EINEN HALBEN POSTENZEITRAUM AB, statt ihn zu verschlucken', async () => {
    const called = setFetchReady({ invoice: DRAFT });
    open(DRAFT_ID);

    // Der Posten-Zeitraum liegt hinter „Abweichender Zeitraum".
    fireEvent.click(await screen.findByRole('button', { name: /Abweichender Zeitraum/ }));
    fireEvent.change(await screen.findByLabelText('Zeitraum von'), {
      target: { value: '2026-08-01' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Speichern$/ }));

    expect(
      await screen.findByText('Bitte beide Daten angeben oder beide leer lassen.'),
    ).toBeInTheDocument();
    expect(
      called.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
      ),
    ).toBe(false);
  });

  it('bietet „Entwurf verwerfen" genau EINMAL an', async () => {
    // Vor dem Umbau stand derselbe Weg zweimal auf der Seite: als Textlink
    // unten und als Knopf in der rechten Spalte.
    setFetchReady({ invoice: DRAFT });
    open(DRAFT_ID);

    await screen.findByLabelText('Rechnungsnummer');
    expect(screen.getAllByRole('button', { name: /verwerfen/i })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Entwurf löschen' })).toBeNull();
  });
});

/**
 * DIE ALTEN RECHNUNGSADRESSEN — sie dürfen nicht ins Leere laufen.
 *
 * Bis zum Redesign lag jede Rechnung unter
 * `/companies/:id/invoices/:invoiceId`. Die Aufgabenquelle
 * `rechnung-ueberfaellig` liefert diesen Pfad bis heute als Ziel, und
 * Lesezeichen zeigen dorthin. Ohne Weiterleitung fiele beides auf die
 * Auffangroute — und die schickt STILL auf die Startseite. Ein Klick auf eine
 * Aufgabe landete auf „Heute", ohne dass irgendetwas nach Fehler aussähe.
 */
describe('Der alte Rechnungsweg leitet weiter', () => {
  it('führt von der organisationsgebundenen Adresse auf die kanonische', async () => {
    setFetchReady({ invoice: FINALIZED });
    open(FINALIZED_ID);

    await screen.findByRole('heading', { name: 'Rechnung 2026-014' });
    expect(window.location.pathname).toBe(`/invoices/${FINALIZED_ID}`);
  });

  it('LEITET DIE NEUANLAGE NICHT WEITER — sie hat noch keine Kennung', async () => {
    // `neu` ist ein Wortzeichen, keine Rechnung. Eine Weiterleitung auf
    // `/invoices/new` führte auf eine Seite, die eine Rechnung mit der
    // Kennung „neu" laden wollte — und keine fände.
    setFetchReady();
    open('new');

    expect(await screen.findByText('Standardpaket')).toBeInTheDocument();
    expect(window.location.pathname).toBe(
      `/companies/${ORG}/invoices/new`,
    );
  });

  it('findet die Organisation über die Rechnung, nicht über den Pfad', async () => {
    // Die kanonische Adresse nennt die Organisation nicht. Der Kopf zeigt sie
    // trotzdem — geladen aus `rechnung.organisationId`.
    setFetchReady({ invoice: FINALIZED });
    window.history.pushState({}, '', `/invoices/${FINALIZED_ID}`);
    renderWithI18n(<App />);

    expect(
      await screen.findByRole('heading', { name: 'Rechnung 2026-014' }),
    ).toBeInTheDocument();
    // Der Name der Organisation kommt aus `holeOrganisation` — geladen über
    // `rechnung.organisationId`, nicht über einen Pfadabschnitt.
    expect(screen.getAllByText(/Solawi Rheintal/).length).toBeGreaterThan(0);
  });
});
