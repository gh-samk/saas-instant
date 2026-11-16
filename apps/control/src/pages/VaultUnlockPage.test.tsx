import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as matchers from 'vitest-axe/matchers';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { ApiError } from '../lib/api-client';
import { VaultUnlockPage } from './VaultUnlockPage';

expect.extend(matchers);

const vaultUnlock = vi.fn();
vi.mock('../lib/api', () => ({
  vaultUnlock: (...a: unknown[]) => vaultUnlock(...a),
}));
const reload = vi.fn();
const logout = vi.fn();
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ reload, logout, state: null }),
}));
const markUnlocked = vi.fn();
const refresh = vi.fn();
vi.mock('../context/VaultContext', () => ({
  useVault: () => ({ status: 'locked', markUnlocked, refresh }),
}));

function submitWith(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Entsperren' }));
}

describe('VaultUnlockPage', () => {
  beforeEach(() => {
    vaultUnlock.mockReset();
    markUnlocked.mockReset();
    refresh.mockReset();
    reload.mockReset().mockResolvedValue(undefined);
    logout.mockReset();
  });

  it('hat ein Feld und einen Knopf, der Knopf bleibt ohne Eingabe gesperrt', () => {
    render(<VaultUnlockPage />);
    expect(screen.getByRole('heading', { name: 'Verwaltung entsperren' })).toBeInTheDocument();
    expect(screen.getByLabelText('Passphrase')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Entsperren' })).toBeDisabled();
  });

  it('entsperrt mit der Passphrase und meldet es dem Tor', async () => {
    vaultUnlock.mockResolvedValue({ state: 'unlocked' });
    render(<VaultUnlockPage />);
    submitWith('Passphrase', 'ein langer sicherer satz');
    await waitFor(() => expect(markUnlocked).toHaveBeenCalledTimes(1));
    expect(vaultUnlock).toHaveBeenCalledWith('ein langer sicherer satz');
  });

  it('zeigt bei falscher Passphrase einen verständlichen Text und bleibt gesperrt', async () => {
    vaultUnlock.mockRejectedValue(
      new ApiError({ code: 'vault_wrong_secret', message: 'technisch' }, 401),
    );
    render(<VaultUnlockPage />);
    submitWith('Passphrase', 'falsch falsch falsch');
    expect(
      await screen.findByText('Die Passphrase stimmt nicht. Bitte prüfe die Eingabe.'),
    ).toBeInTheDocument();
    expect(markUnlocked).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Passphrase')).toBeInvalid();
  });

  it('wechselt mit einem Link zum Wiederherstellungsschlüssel und zurück', async () => {
    vaultUnlock.mockResolvedValue({ state: 'unlocked' });
    render(<VaultUnlockPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Mit Wiederherstellungsschlüssel entsperren' }));

    const field = screen.getByLabelText('Wiederherstellungsschlüssel');
    expect(field).toHaveAttribute('type', 'text');
    expect(screen.queryByLabelText('Passphrase')).toBeNull();

    submitWith('Wiederherstellungsschlüssel', '  abcdefgh-ijklmnop  ');
    await waitFor(() => expect(markUnlocked).toHaveBeenCalled());
    // Eingabe wird nur getrimmt; Bindestriche und Schreibweise prüft der Server.
    expect(vaultUnlock).toHaveBeenCalledWith('abcdefgh-ijklmnop');

    fireEvent.click(screen.getByRole('button', { name: 'Mit Passphrase entsperren' }));
    expect(screen.getByLabelText('Passphrase')).toBeInTheDocument();
  });

  it('nennt beim falschen Schlüssel den Schlüssel, nicht die Passphrase', async () => {
    vaultUnlock.mockRejectedValue(
      new ApiError({ code: 'vault_wrong_secret', message: 'technisch' }, 401),
    );
    render(<VaultUnlockPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Mit Wiederherstellungsschlüssel entsperren' }));
    submitWith('Wiederherstellungsschlüssel', 'AAAA');
    expect(
      await screen.findByText('Der Wiederherstellungsschlüssel stimmt nicht. Bitte prüfe die Eingabe.'),
    ).toBeInTheDocument();
  });

  it('nennt bei zu vielen Fehlversuchen die Wartezeit', async () => {
    vaultUnlock.mockRejectedValue(
      new ApiError(
        { code: 'vault_rate_limited', message: 'technisch', detail: { retryAfterSeconds: 90 } },
        429,
      ),
    );
    render(<VaultUnlockPage />);
    submitWith('Passphrase', 'irgendwas langes');
    expect(
      await screen.findByText('Zu viele Fehlversuche. Bitte in 01:30 erneut versuchen.'),
    ).toBeInTheDocument();
  });

  it('lädt bei abgelaufener Sitzung den Anmeldestand neu', async () => {
    vaultUnlock.mockRejectedValue(new ApiError({ code: 'HTTP_401', message: 'x' }, 401));
    render(<VaultUnlockPage />);
    submitWith('Passphrase', 'irgendwas langes');
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(markUnlocked).not.toHaveBeenCalled();
  });

  it('bietet das Abmelden an', () => {
    render(<VaultUnlockPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Abmelden' }));
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('hat keine Barrierefreiheitsverstöße', async () => {
    const { container } = render(<VaultUnlockPage />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
