import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { axe } from 'vitest-axe';
import * as matchers from 'vitest-axe/matchers';
import { ToastProvider } from '@saas-instant/ui';
import { ApiError } from '../lib/api-client';
import type { PriceList } from '../lib/api';
import { coverage, grossCent, PricesCard } from './PricesCard';

expect.extend(matchers);

const fetchPrices = vi.fn();
const savePrices = vi.fn();
vi.mock('../lib/api', () => ({
  fetchPrices: (...a: unknown[]) => fetchPrices(...a),
  savePrices: (...a: unknown[]) => savePrices(...a),
}));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ reload: vi.fn().mockResolvedValue(undefined), state: { totpSetUp: false } }),
}));

const LIST: PriceList = {
  taxRatePercent: 19,
  paymentTermDays: 14,
  averageDays: 90,
  currency: 'EUR',
  updatedAt: '2026-11-01T10:00:00.000Z',
  tiers: [
    { key: 'klein', label: 'Klein', maxPersons: 10, monthlyCent: 1000, halfYearlyCent: 5500, yearlyCent: 11000, setupCent: 5000, archived: false },
    { key: 'mittel', label: 'Mittel', maxPersons: 30, monthlyCent: 2000, halfYearlyCent: 11000, yearlyCent: 22000, setupCent: 5000, archived: false },
    { key: 'gross', label: 'Groß', maxPersons: null, monthlyCent: 3000, halfYearlyCent: 16500, yearlyCent: 33000, setupCent: 5000, archived: false },
  ],
};

function renderCard() {
  return render(
    <ToastProvider>
      <PricesCard />
    </ToastProvider>,
  );
}

async function loaded() {
  renderCard();
  await screen.findByDisplayValue('Klein');
}

describe('PricesCard', () => {
  beforeEach(() => {
    fetchPrices.mockReset().mockResolvedValue(LIST);
    savePrices.mockReset();
  });

  it('zeigt Stufen, Brutto-Vorschau und Abdeckung', async () => {
    await loaded();
    expect(screen.getByDisplayValue('Mittel')).toBeInTheDocument();
    // 10,00 € netto bei 19 % = 11,90 € brutto
    expect(screen.getAllByText(/Brutto: Monat 11,90/).length).toBeGreaterThan(0);
    expect(screen.getByText(/bis 10 · 11 bis 30 · ab 31/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preise speichern' })).toBeDisabled();
  });

  it('rechnet Brutto in ganzen Cent und beschreibt die Abdeckung', () => {
    expect(grossCent(1000, 19)).toBe(1190);
    expect(grossCent(4999, 7)).toBe(5349);
    expect(grossCent(1000, 0)).toBe(1000);
    const tiers = LIST.tiers;
    expect(coverage(tiers, (k, p) => `${k}${JSON.stringify(p ?? {})}`)).toContain('pricesCoverageUpTo');
  });

  it('speichert die Liste in Cent, erst ohne Nachweis', async () => {
    savePrices.mockResolvedValue({ ...LIST, paymentTermDays: 30 });
    await loaded();
    fireEvent.change(screen.getByLabelText('Zahlungsziel (Tage)'), { target: { value: '30' } });
    fireEvent.change(screen.getAllByLabelText('Monat (netto, €)')[0]!, { target: { value: '12,50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preise speichern' }));

    await waitFor(() => expect(savePrices).toHaveBeenCalledTimes(1));
    const [sent, evidence] = savePrices.mock.calls[0]!;
    expect(evidence).toBeUndefined();
    expect(sent.paymentTermDays).toBe(30);
    expect(sent.taxRatePercent).toBe(19);
    expect(sent.tiers[0]).toMatchObject({ key: 'klein', monthlyCent: 1250, maxPersons: 10, archived: false });
    expect(sent.tiers[2]).toMatchObject({ key: 'gross', maxPersons: null });
    expect(await screen.findByText('Preise gespeichert.')).toBeInTheDocument();
  });

  it('verlangt bei „Nachweis nötig" den zweiten Faktor und wiederholt damit', async () => {
    savePrices
      .mockRejectedValueOnce(
        new ApiError({ code: 'login_failed', message: 'Nachweis nötig.' }, 401),
      )
      .mockResolvedValueOnce(LIST);
    await loaded();
    fireEvent.change(screen.getByLabelText('Zahlungsziel (Tage)'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preise speichern' }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Passwort/), { target: { value: 'geheim-1234' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Bestätigen|Weiter|Speichern/ }));

    await waitFor(() => expect(savePrices).toHaveBeenCalledTimes(2));
    expect(savePrices.mock.calls[1]![1]).toEqual({ currentPassword: 'geheim-1234' });
  });

  it('warnt bei Lücken und sperrt das Speichern', async () => {
    await loaded();
    // Die offene Stufe bekommt eine Schwelle: danach gibt es keine offene Stufe mehr.
    fireEvent.change(screen.getAllByLabelText('Bis aktive Personen')[2]!, { target: { value: '50' } });
    expect(await screen.findByText(/Genau eine aktive Stufe muss nach oben offen sein/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preise speichern' })).toBeDisabled();
    expect(savePrices).not.toHaveBeenCalled();
  });

  it('warnt, wenn Schwellen nicht steigen', async () => {
    await loaded();
    fireEvent.change(screen.getAllByLabelText('Bis aktive Personen')[1]!, { target: { value: '5' } });
    expect(await screen.findByText(/Die Schwellen müssen von Stufe zu Stufe steigen/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preise speichern' })).toBeDisabled();
  });

  it('archiviert eine Stufe und schickt sie archiviert mit', async () => {
    savePrices.mockResolvedValue(LIST);
    await loaded();
    fireEvent.click(screen.getAllByRole('button', { name: 'Archivieren' })[1]!);
    expect(screen.getByText('Archivierte Stufen')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Preise speichern' }));
    await waitFor(() => expect(savePrices).toHaveBeenCalled());
    const sent = savePrices.mock.calls[0]![0] as PriceList;
    expect(sent.tiers.find((s) => s.key === 'mittel')?.archived).toBe(true);
    expect(sent.tiers).toHaveLength(3);
  });

  it('fügt eine Stufe vor der offenen ein und verlangt eine Bezeichnung', async () => {
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Stufe hinzufügen' }));
    expect(await screen.findByText(/Stufe 3: Die Bezeichnung fehlt/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preise speichern' })).toBeDisabled();
    const labels = screen.getAllByLabelText('Bezeichnung');
    expect(labels).toHaveLength(4);
    // Neu eingefügt vor „Groß" (offene Stufe bleibt letzte)
    expect(labels[3]).toHaveValue('Groß');
    fireEvent.change(labels[2]!, { target: { value: 'Neu' } });
    expect(screen.getByRole('button', { name: 'Preise speichern' })).toBeEnabled();
  });

  it('meldet einen Ladefehler', async () => {
    fetchPrices.mockRejectedValue(new Error('x'));
    renderCard();
    expect(await screen.findByRole('alert')).toHaveTextContent('Die Preisliste konnte nicht geladen werden.');
  });

  it('hat keine a11y-Verstöße', async () => {
    const { container } = renderCard();
    await screen.findByDisplayValue('Klein');
    expect(await axe(container)).toHaveNoViolations();
  });
});
