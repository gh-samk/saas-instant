import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { setViaPortal } from '../lib/portal-session';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';

afterEach(() => {
  setViaPortal(false);
  vi.restoreAllMocks();
});

function dialog(onConfirm = vi.fn()) {
  render(
    <SecondFactorEvidenceDialog
      open
      title="Bestätigen"
      declaration="Warum"
      totpPossible
      loading={false}
      onCancel={() => undefined}
      onConfirm={onConfirm}
    />,
  );
  return onConfirm;
}

describe('SecondFactorEvidenceDialog in einer Portal-Sitzung', () => {
  it('zeigt statt Passwort und TOTP den Step-up beim Portal', () => {
    setViaPortal(true);
    dialog();
    expect(screen.queryByLabelText('Aktuelles Passwort')).toBeNull();
    expect(screen.getByRole('button', { name: 'Im Portal bestätigen' })).toBeInTheDocument();
  });

  it('öffnet das Step-up-Fenster und wiederholt die Aktion nach der Meldung', async () => {
    setViaPortal(true);
    const open = vi.spyOn(window, 'open').mockReturnValue({ close: vi.fn() } as unknown as Window);
    const onConfirm = dialog();
    fireEvent.click(screen.getByRole('button', { name: 'Im Portal bestätigen' }));
    expect(open).toHaveBeenCalledWith(
      '/api/auth/sso/start?return=%2Fstep-up-done&stepup=1',
      'si-step-up',
      expect.any(String),
    );
    const sender = new BroadcastChannel('si-step-up');
    await act(async () => {
      sender.postMessage({ type: 'si-step-up', ok: true });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    sender.close();
    expect(onConfirm).toHaveBeenCalledWith({});
  });

  it('wertet doppelte Meldungen desselben Step-ups nur einmal aus', async () => {
    setViaPortal(true);
    vi.spyOn(window, 'open').mockReturnValue({ close: vi.fn() } as unknown as Window);
    const onConfirm = dialog();
    fireEvent.click(screen.getByRole('button', { name: 'Im Portal bestätigen' }));
    const sender = new BroadcastChannel('si-step-up');
    await act(async () => {
      sender.postMessage({ type: 'si-step-up', ok: true });
      sender.postMessage({ type: 'si-step-up', ok: true });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    sender.close();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('wiederholt die Aktion NICHT, wenn der Step-up scheitert, und meldet es', async () => {
    setViaPortal(true);
    vi.spyOn(window, 'open').mockReturnValue({ close: vi.fn() } as unknown as Window);
    const onConfirm = dialog();
    fireEvent.click(screen.getByRole('button', { name: 'Im Portal bestätigen' }));
    const sender = new BroadcastChannel('si-step-up');
    await act(async () => {
      sender.postMessage({ type: 'si-step-up', ok: false });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    sender.close();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('nicht gelungen');
  });

  it('meldet blockierte Pop-ups', () => {
    setViaPortal(true);
    vi.spyOn(window, 'open').mockReturnValue(null);
    dialog();
    fireEvent.click(screen.getByRole('button', { name: 'Im Portal bestätigen' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Pop-ups');
  });

  it('bleibt in einer lokalen Sitzung beim Passwortdialog', () => {
    dialog();
    expect(screen.getByLabelText('Aktuelles Passwort')).toBeInTheDocument();
  });
});
