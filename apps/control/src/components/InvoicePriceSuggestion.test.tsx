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
    render(<InvoicePriceSuggestion suggestion={SUGGESTION} loadError={null} onAdopt={adopt} />);

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
    render(<InvoicePriceSuggestion suggestion={SUGGESTION} loadError={null} onAdopt={adopt} />);
    expect(adopt).not.toHaveBeenCalled();
  });
});
