import { describe, expect, it } from 'vitest';
import { afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithI18n as render } from './test-support/render-with-i18n';
import App from './App';
import { axe } from 'vitest-axe';
import * as matchers from 'vitest-axe/matchers';
import { CheckCircle2, Landmark, Mail, Trash2 } from 'lucide-react';
import {
  FilterChips,
  DangerCard,
  IconButton,
  MetricTile,
  Button,
  NoticeBar,
  StatusPill,
  Table,
  RowLink,
} from '@saas-instant/ui';

expect.extend(matchers);

/**
 * Zugänglichkeit der Verwaltung — bisher gab es das hier nicht.
 *
 * `apps/web` prüft seit Etappe 1 mit `vitest-axe`; `apps/control` nicht,
 * obwohl gerade dieser Bereich ausdrückliche Zusagen macht: sichtbarer
 * Fokusring, jeder Icon-Knopf beschriftet, Status nie nur über Farbe,
 * klickbare Zeilen mit Tastatur bedienbar. Zusagen ohne Prüfung sind
 * Absichten.
 *
 * Diese Datei fängt mit den neuen Bausteinen an. Mit jeder Etappe kommt der
 * jeweils umgebaute Screen dazu — die Prüfung wächst mit dem Redesign, statt
 * am Ende nachgeholt zu werden.
 */

describe('Die Bausteine des Redesigns sind zugänglich', () => {
  it('Statusleiste, Kennzahl und Hinweisstreifen', async () => {
    const { container } = render(
      <main>
        <h1>Rechnungen</h1>
        <FilterChips
          chips={[
            { value: 'all', label: 'Alle', count: 7 },
            { value: 'open', label: 'Offen', count: 2 },
          ]}
          active="all"
          onSelect={() => {}}
          label="Rechnungsstand"
        />
        <MetricTile
          Icon={Landmark}
          number="1.860,00 €"
          label="Offene Beträge"
          kind="attention"
          onClick={() => {}}
        />
        <NoticeBar kind="confirmed" action={<Button variant="secondary">Einwilligungen</Button>}>
          Versand nur an bestätigte Einwilligungen — geprüft vor jeder Mail.
        </NoticeBar>
      </main>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('Tabelle im Listenstil mit Statuspille und Handlungen je Zeile', async () => {
    const { container } = render(
      <main>
        <h1>Organisationen</h1>
        <Table
          columns={['Organisation', 'Status', 'Offen', 'Aktionen']}
          label="Organisationen"
          variant="list"
          actionColumn
          minWidth="min-w-[880px]"
        >
          <tr>
            <td>Solawi Gemeinschaftsgarten Nordost e.V.</td>
            <td>
              <StatusPill kind="notice" extra="läuft" withPoint>
                Pilot
              </StatusPill>
            </td>
            <td>1.240,00 €</td>
            <td>
              <IconButton Icon={CheckCircle2} label="Als bezahlt markieren" />
              <IconButton Icon={Mail} label="Erinnerung senden" />
              <RowLink href="/companies/1">Erledigen</RowLink>
            </td>
          </tr>
        </Table>
      </main>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('Karte für den unumkehrbaren Vorgang', async () => {
    const { container } = render(
      <main>
        <h1>Datenschutz</h1>
        <DangerCard
          title="Kontaktdaten löschen"
          action={
            <Button variant="danger">
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              Löschen …
            </Button>
          }
        >
          Personenbezug entfernen · Datensatz und Verlauf bleiben · endgültig
        </DangerCard>
      </main>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

/**
 * Die umgebauten Screens der Etappe 2.
 *
 * Sie laufen ueber die echte Anwendung (`App`), nicht ueber nachgebaute
 * Bruchstuecke: Geprueft werden soll, was ausgeliefert wird — samt Rahmen,
 * Navigation und Reiterleiste.
 */
describe('Etappe 2 — Rahmen, Liste und Detailseite', () => {
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

  const COMPANY = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Solawi Gemeinschaftsgarten Nordost e.V.',
    status: 'trial',
    city: 'Berlin',
    contactName: 'Elif Aydin',
    contactEmail: 'elif@example.com',
    lastStatusChangeAt: null,
    createdAt: '2026-04-02T09:12:00.000Z',
    instanceStatus: 'active',
    openAmountCent: 124_000,
    openOverdue: false,
  };

  function arrange() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const path = String(input);
        if (path.includes('/api/auth/csrf'))
          return new Response(JSON.stringify({ csrfToken: 'abc' }), { status: 200 });
        if (path.includes('/api/auth/me'))
          return new Response(JSON.stringify(STATE), { status: 200 });
        if (path.includes('/api/navigation/counters'))
          return new Response(
            JSON.stringify({ tasksUrgent: 3, invoicesOpen: 2 }),
            { status: 200 },
          );
        if (path.match(/\/api\/companies\/[0-9a-f-]+$/))
          return new Response(
            JSON.stringify({ ...COMPANY, paymentDetailsStored: false }),
            { status: 200 },
          );
        if (path.includes('/api/companies'))
          return new Response(
            JSON.stringify({
              companies: [COMPANY],
              total: 1,
              page: 1,
              perPage: 25,
              countPerStatus: { trial: 1 },
            }),
            { status: 200 },
          );
        if (path.includes('/api/tasks'))
          return new Response(
            JSON.stringify({
              tasks: [],
              shortened: [],
              orphanedApplications: [],
              state: {
                tag: '2026-09-01',
                since: '2026-08-25',
                limitPerKind: 25,
                reconciliation: { lastAt: null, successful: false, message: null },
              },
            }),
            { status: 200 },
          );
        return new Response('{}', { status: 200 });
      }),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.pushState({}, '', '/');
  });

  it('Organisationsliste mit Filterchips und Zaehlerpillen', async () => {
    arrange();
    window.history.pushState({}, '', '/companies');
    const { container } = render(<App />);
    await screen.findByRole('table');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('Detailseite mit sechs Reitern', async () => {
    arrange();
    window.history.pushState({}, '', `/companies/${COMPANY.id}`);
    const { container } = render(<App />);
    await screen.findByRole('group', { name: 'Bereich der Organisation' });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('Datenschutz-Reiter mit der Karte fuer den unumkehrbaren Vorgang', async () => {
    arrange();
    window.history.pushState(
      {},
      '',
      `/companies/${COMPANY.id}?tab=privacy`,
    );
    const { container } = render(<App />);
    await screen.findByRole('heading', { name: 'Kontaktdaten löschen' });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Etappe 4 — die globale Rechnungsliste', () => {
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

  const INVOICE = {
    id: 'r1',
    companyId: '11111111-1111-4111-8111-111111111111',
    companyName: 'Verein Beispielgarten',
    invoiceNumber: '2026-0151',
    status: 'finalized',
    paymentState: 'overdue',
    invoiceDate: '2026-08-01',
    servicePeriodFrom: '2026-08-01',
    servicePeriodUntil: '2026-08-31',
    dueDate: '2026-08-15',
    sumGrossCent: 48_000,
    sumGross: '480,00',
    openAmount: '480,00',
    paidAmount: null,
    recipientName: 'Verein Beispielgarten',
    recipientEmail: 'kasse@beispielgarten.example',
    sumNetCent: 48_000,
    sumTaxCent: 0,
    lines: [],
    documentPresent: false,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.pushState({}, '', '/');
  });

  it('Kacheln, Chips und Aktionsspalte', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const path = String(input);
        if (path.includes('/api/auth/csrf'))
          return new Response(JSON.stringify({ csrfToken: 'abc' }), { status: 200 });
        if (path.includes('/api/auth/me'))
          return new Response(JSON.stringify(STATE), { status: 200 });
        if (path.includes('/api/invoices/metrics'))
          return new Response(
            JSON.stringify({
              year: 2026,
              openCent: 186_000,
              openCount: 2,
              overdueCent: 48_000,
              overdueCount: 1,
              paidCent: 2_448_000,
            }),
            { status: 200 },
          );
        if (path.includes('/api/invoices'))
          return new Response(
            JSON.stringify({
              invoices: [INVOICE],
              total: 1,
              page: 1,
              perPage: 25,
              countPerState: {
                draft: 0,
                open: 1,
                overdue: 1,
                partially_paid: 0,
                paid: 2,
                cancelled: 0,
              },
            }),
            { status: 200 },
          );
        if (path.includes('/api/navigation/counters'))
          return new Response(
            JSON.stringify({ tasksUrgent: 0, invoicesOpen: 2 }),
            { status: 200 },
          );
        return new Response('{}', { status: 200 });
      }),
    );

    window.history.pushState({}, '', '/invoices');
    const { container } = render(<App />);
    await screen.findByRole('table');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Etappe 4 — der zweispaltige Bearbeiten-Schirm', () => {
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

  const COMPANY_ID = '11111111-1111-4111-8111-111111111111';

  const DRAFT = {
    id: 'r9',
    companyId: COMPANY_ID,
    companyName: 'Verein Beispielgarten',
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
    sumGrossCent: 58_310,
    cancellationInvoiceId: null,
    cancelledInvoiceId: null,
    cancellationReason: null,
    isCancellation: false,
    recipientName: 'Verein Beispielgarten',
    recipientAddress: 'Hauptstraße 12\n79098 Freiburg\nDeutschland',
    recipientEmail: 'vorstand@example.com',
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

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.pushState({}, '', '/');
  });

  /**
   * DER SCHIRM MIT DEN MEISTEN FORMULARFELDERN IM GANZEN BEREICH — und
   * deshalb der, an dem eine fehlende Beschriftung am ehesten durchrutscht.
   * Zwei Fallen stecken bauartbedingt darin: das GESPERRTE Nummernfeld (ein
   * `disabled` Feld ohne Label ist trotzdem ein Verstoß) und die drei
   * Textbereiche, die neu hinzugekommen sind.
   */
  it('Formularfelder, gesperrte Nummer und rechte Spalte', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const path = String(input);
        if (path.includes('/api/auth/csrf'))
          return new Response(JSON.stringify({ csrfToken: 'abc' }), { status: 200 });
        if (path.includes('/api/auth/me'))
          return new Response(JSON.stringify(STATE), { status: 200 });
        if (path.includes('/price-suggestion'))
          return new Response(
            JSON.stringify({ tier: null, blocker: 'no_instance' }),
            { status: 200 },
          );
        if (path.includes(`/api/companies/${COMPANY_ID}`))
          return new Response(
            JSON.stringify({
              id: COMPANY_ID,
              name: 'Verein Beispielgarten',
              legalForm: 'e. V.',
              street: 'Hauptstraße',
              houseNumber: '12',
              postalCode: '79098',
              city: 'Freiburg',
              country: 'Deutschland',
              status: 'paying',
            }),
            { status: 200 },
          );
        if (path.includes('/api/invoices/r9'))
          return new Response(JSON.stringify(DRAFT), { status: 200 });
        if (path.includes('/api/navigation/counters'))
          return new Response(
            JSON.stringify({ tasksUrgent: 0, invoicesOpen: 1 }),
            { status: 200 },
          );
        return new Response('{}', { status: 200 });
      }),
    );

    window.history.pushState({}, '', '/invoices/r9');
    const { container } = render(<App />);
    await screen.findByLabelText('Rechnungsnummer');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Etappe 5 — der Rundmail-Bereich', () => {
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

  const TEMPLATES = [
    {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Neuigkeiten Herbst',
      channel: 'marketing',
      subject: 'Neues aus dem Produkt',
      contentText: 'Hallo {{organisation}}, hier ist die Herbstausgabe.',
      contentHtml: null,
      placeholders: ['company', 'abmeldelink'],
      active: true,
      eyebrow: null,
      heading: null,
      buttonText: null,
      buttonTarget: null,
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-20T10:00:00.000Z',
    },
    {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Zahlungserinnerung',
      channel: 'transactional',
      subject: 'Ihre Rechnung',
      contentText: 'Guten Tag, hier die Erinnerung zu Ihrer Rechnung.',
      contentHtml: null,
      placeholders: ['company'],
      active: true,
      eyebrow: null,
      heading: null,
      buttonText: null,
      buttonTarget: null,
      createdAt: '2026-07-02T10:00:00.000Z',
      updatedAt: '2026-07-02T10:00:00.000Z',
    },
  ];

  const BLOCK = [
    {
      consentId: 's1',
      email: 'alt@example.com',
      status: 'unsubscribed',
      reason: 'telefonisch am 30.08.',
      registeredAt: '2026-08-30T10:00:00.000Z',
    },
    {
      consentId: 's2',
      email: 'selbst@example.com',
      status: 'spam_reported',
      reason: null,
      registeredAt: '2026-07-03T10:00:00.000Z',
    },
  ];

  function arrange() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const path = String(input);
        if (path.includes('/api/auth/csrf'))
          return new Response(JSON.stringify({ csrfToken: 'abc' }), { status: 200 });
        if (path.includes('/api/auth/me'))
          return new Response(JSON.stringify(STATE), { status: 200 });
        if (path.includes('/api/broadcast/counters'))
          return new Response(
            JSON.stringify({ templates: 2, confirmed: 128, blocked: 2 }),
            { status: 200 },
          );
        if (path.includes('/api/broadcast/blocklist'))
          return new Response(JSON.stringify(BLOCK), { status: 200 });
        if (path.includes('/api/broadcast/templates'))
          return new Response(JSON.stringify(TEMPLATES), { status: 200 });
        if (path.includes('/api/broadcast/recipients'))
          return new Response(
            JSON.stringify({
              count: 1,
              notice: 'Stand jetzt.',
              recipient: [
                {
                  consentId: 'e1',
                  email: 'm.kessler@example.com',
                  companyId: '11111111-1111-4111-8111-111111111111',
                  companyName: 'Solawi Nordost',
                  confirmedAt: '2026-08-31T10:00:00.000Z',
                  origin: 'Formular',
                },
              ],
            }),
            { status: 200 },
          );
        if (path.includes('/api/navigation/counters'))
          return new Response(
            JSON.stringify({ tasksUrgent: 0, invoicesOpen: 0 }),
            { status: 200 },
          );
        return new Response('{}', { status: 200 });
      }),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.pushState({}, '', '/');
  });

  it('Vorlagentabelle mit Kanalpille und gesperrtem Sendeknopf', async () => {
    arrange();
    window.history.pushState({}, '', '/broadcast');
    const { container } = render(<App />);
    await screen.findByRole('table');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('Sperrliste — Formular in einer Zeile über der Tabelle', async () => {
    // DER HEIKLE TEIL: Das Formular hat vier Bedienelemente nebeneinander,
    // und der Knopf steht ohne eigene Beschriftung in derselben Zeile.
    arrange();
    window.history.pushState({}, '', '/broadcast/blocklist');
    const { container } = render(<App />);
    await screen.findByRole('table');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('Einwilligungen — Suche, Kennzahl und Nachweistabelle', async () => {
    arrange();
    window.history.pushState({}, '', '/broadcast/consents');
    const { container } = render(<App />);
    await screen.findByRole('table');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Etappen 6 und 8 — Einstellungen mit vier Reitern', () => {
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

  function arrange() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const path = String(input);
        if (path.includes('/api/auth/csrf'))
          return new Response(JSON.stringify({ csrfToken: 'abc' }), { status: 200 });
        if (path.includes('/api/auth/me'))
          return new Response(JSON.stringify(STATE), { status: 200 });
        if (path.includes('/api/access/devices'))
          return new Response(JSON.stringify({ devices: [] }), { status: 200 });
        if (path.includes('/api/audit/security'))
          return new Response(
            JSON.stringify([
              {
                id: 'a1',
                timestamp: '2026-09-01T03:14:00.000Z',
                action: 'anmeldung.passwort.fehler',
                text: 'Fehlgeschlagene Anmeldung (Passwort)',
                actor: 'sam',
                suspicious: true,
                ip: '203.0.113.9',
              },
            ]),
            { status: 200 },
          );
        if (path.includes('/api/users'))
          return new Response(
            JSON.stringify([
              {
                id: 'b1',
                name: 'Testbetreiberin',
                username: 'test',
                email: 'test@example.com',
                role: 'inhaber',
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
            ]),
            { status: 200 },
          );
        if (path.includes('/api/navigation/counters'))
          return new Response(
            JSON.stringify({ tasksUrgent: 0, invoicesOpen: 0 }),
            { status: 200 },
          );
        return new Response('{}', { status: 200 });
      }),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.pushState({}, '', '/');
  });

  it('Sicherheit — Wiederherstellungscodes und Protokoll', async () => {
    arrange();
    window.history.pushState({}, '', '/settings?tab=security');
    const { container } = render(<App />);
    await screen.findByRole('table');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('Nutzer — Tabelle mit gesperrten Knöpfen und ihrem `title`', async () => {
    // DER HEIKLE TEIL: Ein deaktivierter Knopf mit `title` als einziger
    // Begründung ist auf Touch-Geräten unsichtbar — und für `axe` ein
    // Kandidat für „button without accessible name", wenn die Beschriftung
    // fehlte.
    arrange();
    window.history.pushState({}, '', '/settings?tab=user');
    const { container } = render(<App />);
    await screen.findByRole('table');
    expect(await axe(container)).toHaveNoViolations();
  });
});
