import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { axe } from 'vitest-axe';
import * as matchers from 'vitest-axe/matchers';
import { ToastProvider } from '@saas-instant/ui';
import { ApiError } from '../lib/api-client';
import type { PriceList } from '../lib/api';
import {
  coverage,
  grossCent,
  halfYearlyFromMonthly,
  keyFromLabel,
  PricesCard,
  yearlyFromMonthly,
} from './PricesCard';

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
    // Ohne Änderungen steht keine Speicherleiste da.
    expect(screen.queryByRole('button', { name: 'Preise speichern' })).not.toBeInTheDocument();
  });

  it('zeigt aktive Stufen als eine Zeile je Stufe mit „bis N Personen" aus dem Grenzwert', async () => {
    await loaded();
    const rows = screen.getAllByRole('listitem').filter((li) => li.querySelector('input'));
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByLabelText('Bezeichnung')).toHaveValue('Klein');
    expect(within(rows[0]!).getByLabelText('Bis aktive Personen')).toHaveValue('10');
    expect(within(rows[0]!).getByText('bis 10 Personen')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('ab 31 Personen')).toBeInTheDocument();
    // Die Hinweisspalte „Schlüssel" gibt es nicht mehr als Feld in der Zeile.
    expect(within(rows[0]!).queryByLabelText('Schlüssel')).not.toBeInTheDocument();
  });

  it('verdoppelt „bis N Personen" nicht, wenn der Name die Zahl schon trägt', async () => {
    fetchPrices.mockResolvedValue({
      ...LIST,
      tiers: [{ ...LIST.tiers[0]!, label: 'Klein (bis 10 Personen)' }, ...LIST.tiers.slice(1)],
    });
    renderCard();
    await screen.findByDisplayValue('Klein (bis 10 Personen)');
    expect(screen.queryByText('bis 10 Personen')).not.toBeInTheDocument();
    expect(screen.getByText('bis 30 Personen')).toBeInTheDocument();
  });

  it('erzeugt den Schlüssel einer neuen Stufe aus dem Namen und hält ihn eindeutig', () => {
    expect(keyFromLabel('Groß Plus', new Set())).toBe('gross-plus');
    expect(keyFromLabel('Übergröße (neu)!', new Set())).toBe('uebergroesse-neu');
    expect(keyFromLabel('', new Set())).toBe('stufe');
    expect(keyFromLabel('Klein', new Set(['klein']))).toBe('klein-2');
    expect(keyFromLabel('Klein', new Set(['klein', 'klein-2']))).toBe('klein-3');
    expect(keyFromLabel('x'.repeat(100), new Set())).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/);
  });

  it('gibt einer neuen Stufe den erzeugten Schlüssel, ändert gespeicherte nie', async () => {
    savePrices.mockResolvedValue(LIST);
    await loaded();
    // Gespeicherte Stufe umbenennen: Schlüssel bleibt „klein".
    fireEvent.change(screen.getAllByLabelText('Bezeichnung')[0]!, { target: { value: 'Winzig' } });
    fireEvent.click(screen.getByRole('button', { name: 'Stufe hinzufügen' }));
    fireEvent.change(screen.getAllByLabelText('Bezeichnung')[2]!, { target: { value: 'Klein' } });
    // Der Name „Klein" ist frei (die alte Stufe heißt jetzt anders), der Schlüssel „klein" aber vergeben.
    fireEvent.click(screen.getByRole('button', { name: 'Preise speichern' }));
    await waitFor(() => expect(savePrices).toHaveBeenCalled());
    const sent = savePrices.mock.calls[0]![0] as PriceList;
    expect(sent.tiers.map((x) => x.key)).toEqual(['klein', 'mittel', 'klein-2', 'gross']);
    expect(sent.tiers[0]).toMatchObject({ key: 'klein', label: 'Winzig' });
  });

  it('versteckt die Schlüssel hinter „Technische Angaben"', async () => {
    await loaded();
    const details = screen.getByText('Technische Angaben').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(within(details).getByText('klein')).toBeInTheDocument();
  });

  it('berechnet Halbjahr und Jahr aus dem Monatspreis, nur auf Knopfdruck', async () => {
    expect(halfYearlyFromMonthly(1000)).toBe(5500);
    expect(halfYearlyFromMonthly(1001)).toBe(5506);
    expect(yearlyFromMonthly(1000)).toBe(11000);
    await loaded();
    const monthly = screen.getAllByLabelText('Monat (netto, €)')[0]!;
    fireEvent.change(monthly, { target: { value: '20,00' } });
    // Nichts wird von selbst überschrieben.
    expect(screen.getAllByLabelText('Halbjahr (netto, €)')[0]).toHaveValue('55.00');
    fireEvent.click(screen.getAllByRole('button', { name: /Halbjahr aus dem Monatspreis/ })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: /Jahr aus dem Monatspreis/ })[0]!);
    expect(screen.getAllByLabelText('Halbjahr (netto, €)')[0]).toHaveValue('110.00');
    expect(screen.getAllByLabelText('Jahr (netto, €)')[0]).toHaveValue('220.00');
    // Der berechnete Wert bleibt überschreibbar.
    fireEvent.change(screen.getAllByLabelText('Jahr (netto, €)')[0]!, { target: { value: '200' } });
    expect(screen.getAllByLabelText('Jahr (netto, €)')[0]).toHaveValue('200');
  });

  it('zeigt die Speicherleiste erst bei Änderungen und verwirft sie', async () => {
    await loaded();
    expect(screen.queryByRole('region', { name: 'Preise speichern' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Zahlungsziel (Tage)'), { target: { value: '30' } });
    expect(screen.getByRole('region', { name: 'Preise speichern' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Verwerfen' }));
    expect(screen.getByLabelText('Zahlungsziel (Tage)')).toHaveValue('14');
    expect(screen.queryByRole('region', { name: 'Preise speichern' })).not.toBeInTheDocument();
  });

  it('setzt Serverfehler an das Feld der Zeile', async () => {
    savePrices.mockRejectedValue(
      new ApiError(
        {
          code: 'HTTP_400',
          message: 'tiers.1.monthlyCent must not be less than 0',
          detail: ['tiers.1.monthlyCent must not be less than 0'],
        },
        400,
      ),
    );
    await loaded();
    fireEvent.change(screen.getByLabelText('Zahlungsziel (Tage)'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preise speichern' }));
    const field = screen.getAllByLabelText('Monat (netto, €)')[1]!;
    await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'));
    expect(field).toHaveAccessibleDescription('Mindestens 0 erlaubt.');
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
    fireEvent.click(screen.getByRole('button', { name: 'Preise speichern' }));
    expect(await screen.findByText('Bitte behebe zuerst die genannten Punkte.')).toBeInTheDocument();
    expect(savePrices).not.toHaveBeenCalled();
  });

  it('warnt, wenn Schwellen nicht steigen', async () => {
    await loaded();
    fireEvent.change(screen.getAllByLabelText('Bis aktive Personen')[1]!, { target: { value: '5' } });
    expect(await screen.findByText(/Die Schwellen müssen von Stufe zu Stufe steigen/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Preise speichern' }));
    expect(savePrices).not.toHaveBeenCalled();
  });

  it('gibt „aus Monat ×5,5/×11" und „Archivieren" mobil 44 px Trefferfläche', async () => {
    await loaded();
    for (const el of [
      ...screen.getAllByText('aus Monat ×5,5'),
      ...screen.getAllByText('aus Monat ×11'),
      ...screen.getAllByRole('button', { name: /^Archivieren/ }),
    ]) {
      expect(el.closest('button')!.className).toMatch(/\bmin-h-11\b/);
    }
  });

  it('archiviert eine Stufe und schickt sie archiviert mit', async () => {
    savePrices.mockResolvedValue(LIST);
    await loaded();
    fireEvent.click(screen.getAllByRole('button', { name: /^Archivieren/ })[1]!);
    const summary = screen.getByText('Archivierte Stufen (1)');
    // Eingeklappt und nur lesbar.
    expect(summary.closest('details')).not.toHaveAttribute('open');
    expect(within(summary.closest('details')!).queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Preise speichern' }));
    await waitFor(() => expect(savePrices).toHaveBeenCalled());
    const sent = savePrices.mock.calls[0]![0] as PriceList;
    expect(sent.tiers.find((s) => s.key === 'mittel')?.archived).toBe(true);
    expect(sent.tiers).toHaveLength(3);
  });

  it('holt eine archivierte Stufe an die Stelle ihrer Schwelle zurück', async () => {
    fetchPrices.mockResolvedValue({
      ...LIST,
      tiers: [LIST.tiers[0]!, { ...LIST.tiers[1]!, archived: true }, LIST.tiers[2]!],
    });
    savePrices.mockResolvedValue(LIST);
    renderCard();
    await screen.findByDisplayValue('Klein');
    expect(screen.queryByDisplayValue('Mittel')).not.toBeInTheDocument();
    expect(screen.getByText(/Netto: Monat 20,00/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Wiederherstellen/ }));
    expect(screen.getByDisplayValue('Mittel')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Preise speichern' }));
    await waitFor(() => expect(savePrices).toHaveBeenCalled());
    const sent = savePrices.mock.calls[0]![0] as PriceList;
    expect(sent.tiers.map((x) => [x.key, x.archived])).toEqual([
      ['klein', false],
      ['mittel', false],
      ['gross', false],
    ]);
  });

  it('fügt eine Stufe vor der offenen ein und verlangt eine Bezeichnung', async () => {
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Stufe hinzufügen' }));
    expect(await screen.findByText(/Stufe 3: Die Bezeichnung fehlt/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Preise speichern' }));
    expect(savePrices).not.toHaveBeenCalled();
    const labels = screen.getAllByLabelText('Bezeichnung');
    expect(labels).toHaveLength(4);
    // Neu eingefügt vor „Groß" (offene Stufe bleibt letzte)
    expect(labels[3]).toHaveValue('Groß');
    fireEvent.change(labels[2]!, { target: { value: 'Neu' } });
    expect(screen.queryByText(/Stufe 3: Die Bezeichnung fehlt/)).not.toBeInTheDocument();
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
