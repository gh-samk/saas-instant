import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { axe } from 'vitest-axe';
import * as matchers from 'vitest-axe/matchers';
import { ToastProvider } from '@saas-instant/ui';
import { ApiError } from '../lib/api-client';
import { FeatureFlagManagement } from './FeatureFlagManagement';

expect.extend(matchers);

const fetchFeatureFlags = vi.fn();
const setFeatureFlag = vi.fn();
vi.mock('../lib/api', () => ({
  fetchFeatureFlags: (...a: unknown[]) => fetchFeatureFlags(...a),
  setFeatureFlag: (...a: unknown[]) => setFeatureFlag(...a),
}));

const FEEDBACK = {
  key: 'feedback',
  label: 'Feedback in den Instanzen',
  description: 'Zeigt den Punkt „Feedback geben".',
  active: true,
  defaultValue: true,
  changedAt: null,
};

function renderView() {
  return render(
    <ToastProvider>
      <FeatureFlagManagement />
    </ToastProvider>,
  );
}

describe('FunktionsschalterVerwaltung', () => {
  beforeEach(() => {
    fetchFeatureFlags.mockReset().mockResolvedValue([FEEDBACK]);
    setFeatureFlag.mockReset();
  });

  it('zeigt den Schalter mit Stand und Vorgabe', async () => {
    renderView();
    const switchValue = await screen.findByRole('switch', { name: 'Feedback in den Instanzen' });
    expect(switchValue).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Vorgabe: an')).toBeInTheDocument();
  });

  it('schaltet erst um, wenn der Server es bestätigt', async () => {
    let confirm: (value: unknown) => void = () => {};
    setFeatureFlag.mockReturnValue(
      new Promise((r) => {
        confirm = r;
      }),
    );
    renderView();
    const switchValue = await screen.findByRole('switch', { name: 'Feedback in den Instanzen' });
    fireEvent.click(switchValue);

    expect(setFeatureFlag).toHaveBeenCalledWith('feedback', false);
    expect(switchValue).toHaveAttribute('aria-checked', 'true');
    expect(switchValue).toBeDisabled();

    confirm({ ...FEEDBACK, active: false, changedAt: '2026-09-15T10:00:00.000Z' });
    await waitFor(() => expect(switchValue).toHaveAttribute('aria-checked', 'false'));
    expect(screen.getByText('Zuletzt geändert am 15.9.2026')).toBeInTheDocument();
    expect(
      await screen.findByText('Feedback in den Instanzen: ausgeschaltet.'),
    ).toBeInTheDocument();
  });

  it('meldet einen Fehler an der Karte und behält den alten Stand', async () => {
    setFeatureFlag.mockRejectedValue(
      new ApiError({ code: 'HTTP_403', message: 'Nicht erlaubt.' }, 403),
    );
    renderView();
    const switchValue = await screen.findByRole('switch', { name: 'Feedback in den Instanzen' });
    fireEvent.click(switchValue);
    expect(await screen.findByRole('alert')).toHaveTextContent('Nicht erlaubt.');
    expect(switchValue).toHaveAttribute('aria-checked', 'true');
  });

  it('sagt es, wenn die Liste nicht lädt', async () => {
    fetchFeatureFlags.mockRejectedValue(new Error('weg'));
    renderView();
    expect(await screen.findByRole('alert')).toHaveTextContent('nicht laden');
  });

  it('hat keine axe-Verstöße', async () => {
    const { container } = renderView();
    await screen.findByRole('switch');
    expect(await axe(container)).toHaveNoViolations();
  });
});
