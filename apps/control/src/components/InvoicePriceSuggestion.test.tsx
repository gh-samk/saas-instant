import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import type { PriceSuggestion } from '../lib/api';
import { InvoicePriceSuggestion } from './InvoicePriceSuggestion';

/**
 * Der Vorschlag rechnet mit der Stufe aus der Preisliste (DB): Betrag UND
 * Stufenschlüssel gehen in den übernommenen Posten.
 */

const SUGGESTION: PriceSuggestion = {
  tier: {
    key: 'mittel',
    label: 'Mittel (bis 30 Personen)',
    untilPersons: 30,
    monthlyCent: 2450,
    halfYearlyCent: 13475,
    yearlyCent: 26950,
    setupCent: 7500,
  },
  blockers: [],
  averageActivePersons: 22.4,
  measurementDays: 88,
  period: { from: '2026-08-17', until: '2026-11-14' },
  customAmount: null,
  subscriptionCalculableFrom: '2026-02-01',
  subscriptionCalculable: true,
  setupCalculable: true,
};

describe('InvoicePriceSuggestion mit DB-Stufen', () => {
  it('übernimmt Betrag und Stufenschlüssel der Preisliste', () => {
    const adopt = vi.fn();
    render(<InvoicePriceSuggestion suggestion={SUGGESTION} loadError={null} companyId="c1" onAdopt={adopt} />);

    fireEvent.click(screen.getByRole('button', { name: /Monatlichen/ }));
    expect(adopt).toHaveBeenLastCalledWith(
      expect.objectContaining({ unitPriceNetCent: 2450, unit: 'MON', priceTierKey: 'mittel' }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Jährlichen/ }));
    expect(adopt).toHaveBeenLastCalledWith(
      expect.objectContaining({ unitPriceNetCent: 26950, unit: 'ANN', priceTierKey: 'mittel' }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Einrichtungspauschale/ }));
    expect(adopt).toHaveBeenLastCalledWith(
      expect.objectContaining({ unitPriceNetCent: 7500, unit: 'C62', priceTierKey: 'mittel' }),
    );
    expect(adopt).toHaveBeenCalledTimes(3);
  });

  it('legt nie von selbst einen Posten an (R5)', () => {
    const adopt = vi.fn();
    render(<InvoicePriceSuggestion suggestion={SUGGESTION} loadError={null} companyId="c1" onAdopt={adopt} />);
    expect(adopt).not.toHaveBeenCalled();
  });
});

/**
 * „Posten aus Vertrag übernehmen": Stufe und Zahlungsweise stammen von der
 * Organisation, nicht aus der Messung. Weiterhin nur per Klick (R5).
 */
describe('InvoicePriceSuggestion: Posten aus Vertrag', () => {
  const TIER = SUGGESTION.tier!;
  const withContract = (
    contract: NonNullable<PriceSuggestion['contract']>,
    change: Partial<PriceSuggestion> = {},
  ): PriceSuggestion => ({ ...SUGGESTION, contract, ...change });

  it.each([
    ['monthly', 2450, 'MON'],
    ['half_yearly', 13475, 'C62'],
    ['yearly', 26950, 'ANN'],
  ] as const)('übernimmt bei %s den passenden Abo-Posten mit Stufenbezug', (interval, cent, unit) => {
    const adopt = vi.fn();
    render(
      <InvoicePriceSuggestion
        suggestion={withContract({ tierKey: 'mittel', tier: TIER, paymentInterval: interval })}
        loadError={null}
        companyId="c1"
        onAdopt={adopt}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Posten aus Vertrag übernehmen' }));
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(adopt).toHaveBeenCalledWith([
      expect.objectContaining({ unitPriceNetCent: cent, unit, priceTierKey: 'mittel' }),
    ]);
  });

  it('bietet in der Pilotphase nur den Einrichtungsposten an, damit der Knopf nutzbar bleibt', () => {
    const adopt = vi.fn();
    render(
      <InvoicePriceSuggestion
        suggestion={withContract(
          { tierKey: 'mittel', tier: TIER, paymentInterval: 'yearly' },
          { subscriptionCalculable: false, subscriptionCalculableFrom: '2026-12-01' },
        )}
        loadError={null}
        companyId="c1"
        onAdopt={adopt}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Posten aus Vertrag übernehmen' }));
    expect(adopt).toHaveBeenCalledWith([
      expect.objectContaining({ unitPriceNetCent: 7500, unit: 'C62', priceTierKey: 'mittel' }),
    ]);
  });

  it('weist ohne Preisstufe an der Organisation darauf hin und verlinkt dorthin', () => {
    render(
      <InvoicePriceSuggestion
        suggestion={withContract({ tierKey: null, tier: null, paymentInterval: 'monthly' })}
        loadError={null}
        companyId="c1"
        onAdopt={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Posten aus Vertrag übernehmen' })).toBeNull();
    const link = screen.getByRole('link', { name: 'Preisstufe an der Organisation festlegen' });
    expect(link).toHaveAttribute('href', '/companies/c1?tab=contract');
    // Die MESSUNG schlägt eine Stufe vor — der Hinweis sagt es, statt dem
    // Messblock zu widersprechen.
    expect(
      screen.getByText(
        'Im Vertrag ist noch keine Preisstufe festgelegt. Nach der Messung passt Mittel (bis 30 Personen).',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Gemessen:')).toBeInTheDocument();
  });

  it('nennt ohne Preisstufe und ohne Messwert nur den ersten Satz', () => {
    render(
      <InvoicePriceSuggestion
        suggestion={withContract(
          { tierKey: null, tier: null, paymentInterval: 'monthly' },
          { tier: null, blockers: ['no_instance'] },
        )}
        loadError={null}
        companyId="c1"
        onAdopt={vi.fn()}
      />,
    );
    expect(screen.getByText('Im Vertrag ist noch keine Preisstufe festgelegt.')).toBeInTheDocument();
    expect(screen.queryByText(/Nach der Messung/)).toBeNull();
    expect(screen.queryByText('Gemessen:')).toBeNull();
  });

  it('verweist auf die Zahlungsweise, wenn nur sie fehlt, und bietet dann die Einrichtung an', () => {
    const adopt = vi.fn();
    render(
      <InvoicePriceSuggestion
        suggestion={withContract({ tierKey: 'mittel', tier: TIER, paymentInterval: null })}
        loadError={null}
        companyId="c1"
        onAdopt={adopt}
      />,
    );
    expect(screen.getByRole('link', { name: 'Zahlungsweise an der Organisation festlegen' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Posten aus Vertrag übernehmen' }));
    expect(adopt).toHaveBeenCalledWith([expect.objectContaining({ unitPriceNetCent: 7500 })]);
  });

  it('bietet bei abweichendem Betrag keine Stufenpreise aus dem Vertrag an', () => {
    render(
      <InvoicePriceSuggestion
        suggestion={withContract(
          { tierKey: 'mittel', tier: TIER, paymentInterval: 'monthly' },
          { customAmount: '19.00' },
        )}
        loadError={null}
        companyId="c1"
        onAdopt={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Posten aus Vertrag übernehmen' })).toBeNull();
  });
});
