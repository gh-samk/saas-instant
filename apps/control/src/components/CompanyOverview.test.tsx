import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { renderWithI18n } from '../test-support/render-with-i18n';
import type { Company } from '../lib/api';
import { CompanyOverview, setupSteps } from './CompanyOverview';

/**
 * Die Schrittliste im Überblick: offene Schritte mit Knopf, erledigte
 * eingeklappt, „erledigt" aus vorhandenen Daten abgeleitet.
 */

const fetchTasks = vi.fn();
const fetchInquiries = vi.fn();
const fetchInstance = vi.fn();
const fetchInvoices = vi.fn();
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  fetchTasks: (...a: unknown[]) => fetchTasks(...a),
  fetchInquiries: (...a: unknown[]) => fetchInquiries(...a),
  fetchInstance: (...a: unknown[]) => fetchInstance(...a),
  fetchInvoices: (...a: unknown[]) => fetchInvoices(...a),
}));

const NEW_COMPANY = {
  id: 'c1',
  name: 'Neue Organisation',
  status: 'pilot_approved',
  priceTier: null,
  paymentInterval: null,
  pilotDecisionDate: null,
  reviewDueDate: null,
  instanceStartDate: null,
  contactName: null,
  contactEmail: null,
  contactRole: null,
  deputyName: null,
  deputyEmail: null,
} as unknown as Company;

function show(company: Company = NEW_COMPANY) {
  const handlers = {
    onContactEdit: vi.fn(),
    onDeputy: vi.fn(),
    onContract: vi.fn(),
    onInstance: vi.fn(),
    onInvoice: vi.fn(),
  };
  renderWithI18n(
    <MemoryRouter>
      <CompanyOverview company={company} {...handlers} />
    </MemoryRouter>,
  );
  return handlers;
}

beforeEach(() => {
  fetchTasks.mockReset().mockResolvedValue({ tasks: [] });
  fetchInquiries.mockReset().mockResolvedValue({ inquiries: [] });
  fetchInstance.mockReset().mockResolvedValue(null);
  fetchInvoices.mockReset().mockResolvedValue([]);
});

describe('setupSteps: woran „erledigt" erkannt wird', () => {
  const base = { priceTier: null, paymentInterval: null, deputyName: null, deputyEmail: null } as const;

  it('Vertrag ist erst mit Preisstufe UND Zahlungsweise erledigt', () => {
    expect(setupSteps(base, false, false)[0]).toEqual({ id: 'contract', done: false });
    expect(setupSteps({ ...base, priceTier: 'stufe1' }, false, false)[0]?.done).toBe(false);
    expect(setupSteps({ ...base, paymentInterval: 'monthly' }, false, false)[0]?.done).toBe(false);
    expect(setupSteps({ ...base, priceTier: 'stufe1', paymentInterval: 'monthly' }, false, false)[0]?.done).toBe(true);
  });

  it('leitet Instanz, Rechnung und Stellvertretung aus den Daten ab', () => {
    const steps = setupSteps({ ...base, deputyEmail: 'v@example.com' }, true, false);
    expect(steps.map((s) => [s.id, s.done])).toEqual([
      ['contract', false],
      ['instance', true],
      ['invoice', false],
      ['deputy', true],
    ]);
  });

  it('lässt Instanz und Rechnung bei Anfrage und Demo aus', () => {
    for (const status of ['inquiry', 'demo'] as const) {
      expect(setupSteps({ ...base, status }, false, false).map((s) => s.id)).toEqual(['contract', 'deputy']);
    }
    expect(setupSteps({ ...base, status: 'pilot_approved' }, false, false).map((s) => s.id)).toEqual([
      'contract', 'instance', 'invoice', 'deputy',
    ]);
  });

  it('lässt einen Schritt aus, dessen Stand unbekannt ist (Laden gescheitert)', () => {
    expect(setupSteps(base, null, null).map((s) => s.id)).toEqual(['contract', 'deputy']);
  });
});

describe('CompanyOverview: geführter Überblick', () => {
  it('zeigt bei einer neuen Organisation vier offene Schritte mit Knopf und keinen Leerzustand', async () => {
    const handlers = show();
    fireEvent.click(await screen.findByRole('button', { name: 'Vertrag festlegen' }));
    expect(handlers.onContract).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Instanz anlegen' }));
    expect(handlers.onInstance).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Erste Rechnung anlegen' }));
    expect(handlers.onInvoice).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Stellvertretung eintragen' }));
    expect(handlers.onDeputy).toHaveBeenCalledTimes(1);

    expect(screen.queryByText(/Nichts offen/)).toBeNull();
  });

  it('blendet Kennzahlen ohne Wert aus, statt „—" zu zeigen', async () => {
    show();
    await screen.findByRole('button', { name: 'Vertrag festlegen' });
    expect(screen.queryByText('Preisstufe')).toBeNull();
    expect(screen.queryByText('Zahlungsweise')).toBeNull();
    expect(screen.queryByText('Überprüfung')).toBeNull();
    expect(document.body.textContent).not.toContain('—');
  });

  it('klappt erledigte Schritte weg und nennt sie in einer Zeile', async () => {
    fetchInstance.mockResolvedValue({ id: 'i1', status: 'active' });
    fetchInvoices.mockResolvedValue([{ id: 'r1' }]);
    show({
      ...NEW_COMPANY,
      priceTier: 'stufe1',
      paymentInterval: 'half_yearly',
    } as Company);

    // Offen bleibt nur die Stellvertretung.
    await screen.findByRole('button', { name: 'Stellvertretung eintragen' });
    expect(screen.queryByRole('button', { name: 'Vertrag festlegen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Instanz anlegen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Erste Rechnung anlegen' })).toBeNull();

    const summary = screen.getByText('3 von 4 Schritten erledigt');
    const details = summary.closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    await waitFor(() => expect(details.open).toBe(true));
    expect(within(details).getByText('Instanz angelegt')).toBeInTheDocument();
    // Kennzahlen mit Wert bleiben, die Zahlungsweise in Worten.
    expect(screen.getByText('halbjährlich')).toBeInTheDocument();
  });

  it('zeigt den Leerzustand erst, wenn weder Schritte noch Aufgaben offen sind', async () => {
    fetchInstance.mockResolvedValue({ id: 'i1', status: 'active' });
    fetchInvoices.mockResolvedValue([{ id: 'r1' }]);
    show({
      ...NEW_COMPANY,
      priceTier: 'stufe1',
      paymentInterval: 'monthly',
      deputyName: 'Vera Vertretung',
    } as Company);
    expect(await screen.findByText(/Nichts offen/)).toBeInTheDocument();
    expect(screen.getByText('4 von 4 Schritten erledigt')).toBeInTheDocument();
  });

  it('lässt Instanz- und Rechnungsschritt aus, wenn deren Daten nicht ladbar sind', async () => {
    fetchInstance.mockRejectedValue(new Error('x'));
    fetchInvoices.mockRejectedValue(new Error('x'));
    show();
    await screen.findByRole('button', { name: 'Vertrag festlegen' });
    expect(screen.queryByRole('button', { name: 'Instanz anlegen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Erste Rechnung anlegen' })).toBeNull();
  });

  it('zeigt bei einer Anfrage keinen Knopf „Instanz anlegen"', async () => {
    show({ ...NEW_COMPANY, status: 'inquiry' } as Company);
    await screen.findByRole('button', { name: 'Vertrag festlegen' });
    expect(screen.queryByRole('button', { name: 'Instanz anlegen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Erste Rechnung anlegen' })).toBeNull();
  });

  it('zeigt bei beendeter Organisation keine Schrittliste', async () => {
    show({ ...NEW_COMPANY, status: 'ended' } as Company);
    expect(await screen.findByText(/Nichts offen/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Instanz anlegen' })).toBeNull();
  });
});
