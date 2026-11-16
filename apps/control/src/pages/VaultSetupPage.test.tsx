import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as matchers from 'vitest-axe/matchers';
import { ToastProvider } from '@saas-instant/ui';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { ApiError } from '../lib/api-client';
import { VaultSetupPage } from './VaultSetupPage';

expect.extend(matchers);

const vaultSetup = vi.fn();
vi.mock('../lib/api', () => ({
  vaultSetup: (...a: unknown[]) => vaultSetup(...a),
}));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ reload: vi.fn().mockResolvedValue(undefined), state: { totpSetUp: true } }),
}));
const markUnlocked = vi.fn();
const refresh = vi.fn();
vi.mock('../context/VaultContext', () => ({
  useVault: () => ({ status: 'uninitialized', markUnlocked, refresh }),
}));

const KEY = 'ABCDEFGH-IJKLMNOP-QRSTUVWX-YZ234567';
const GOOD = 'ein langer sicherer satz';

function renderPage() {
  return render(
    <ToastProvider>
      <VaultSetupPage />
    </ToastProvider>,
  );
}

function fill(passphrase: string, repeat: string) {
  fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: passphrase } });
  fireEvent.change(screen.getByLabelText('Passphrase wiederholen'), { target: { value: repeat } });
}

describe('VaultSetupPage', () => {
  beforeEach(() => {
    vaultSetup.mockReset();
    markUnlocked.mockReset();
    refresh.mockReset();
  });

  it('warnt vor dem Datenverlust und sperrt den Knopf, bis die Eingabe passt', () => {
    renderPage();
    expect(screen.getByText(/unwiederbringlich verloren/)).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Verschlüsselung einrichten' });
    expect(submit).toBeDisabled();

    fill('zu kurz', 'zu kurz');
    expect(submit).toBeDisabled();

    fill(GOOD, 'ein anderer satz hier');
    expect(submit).toBeDisabled();

    fill(GOOD, GOOD);
    expect(submit).toBeEnabled();
  });

  it('zeigt eine Stärkeanzeige und meldet Abweichungen erst beim Verlassen des Felds', () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: GOOD } });
    expect(screen.getByText(/stark|mittel|schwach/i)).toBeInTheDocument();

    const repeat = screen.getByLabelText('Passphrase wiederholen');
    fireEvent.change(repeat, { target: { value: 'abweichend' } });
    expect(screen.queryByText('Die beiden Eingaben sind nicht gleich.')).toBeNull();
    fireEvent.blur(repeat);
    expect(screen.getByText('Die beiden Eingaben sind nicht gleich.')).toBeInTheDocument();
  });

  it('zeigt nach der Einrichtung den Schlüssel; weiter erst mit dem Häkchen', async () => {
    vaultSetup.mockResolvedValue({ recoveryKey: KEY });
    renderPage();
    fill(GOOD, GOOD);
    fireEvent.click(screen.getByRole('button', { name: 'Verschlüsselung einrichten' }));

    expect(await screen.findByLabelText('Wiederherstellungsschlüssel')).toHaveTextContent(KEY);
    expect(vaultSetup).toHaveBeenCalledWith(GOOD, undefined);
    // Die Passphrase verschwindet aus der Ansicht, der Schlüssel ist der einzige Inhalt.
    expect(screen.queryByLabelText('Passphrase')).toBeNull();

    const done = screen.getByRole('button', { name: 'Fertig, weiter zur Verwaltung' });
    expect(done).toBeDisabled();
    expect(markUnlocked).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('Ich habe den Schlüssel sicher verwahrt.'));
    expect(done).toBeEnabled();
    fireEvent.click(done);
    expect(markUnlocked).toHaveBeenCalledTimes(1);
  });

  it('kopiert den Schlüssel, speichert ihn als TXT und druckt ihn', async () => {
    vaultSetup.mockResolvedValue({ recoveryKey: KEY });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const create = vi.fn(() => 'blob:test');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);

    renderPage();
    fill(GOOD, GOOD);
    fireEvent.click(screen.getByRole('button', { name: 'Verschlüsselung einrichten' }));
    await screen.findByLabelText('Wiederherstellungsschlüssel');

    fireEvent.click(screen.getByRole('button', { name: /Kopieren/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(KEY));

    fireEvent.click(screen.getByRole('button', { name: /Als TXT speichern/ }));
    expect(create).toHaveBeenCalledTimes(1);
    const blob = (create.mock.calls[0] as unknown as [Blob])[0];
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    expect(text).toContain(KEY);
    expect(click).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /Drucken/ }));
    expect(print).toHaveBeenCalledTimes(1);

    click.mockRestore();
    print.mockRestore();
  });

  it('verlangt bei Bedarf den zweiten Faktor und richtet danach ein', async () => {
    vaultSetup
      .mockRejectedValueOnce(
        new ApiError({ code: 'login_failed', message: 'Nachweis nötig.' }, 401),
      )
      .mockResolvedValueOnce({ recoveryKey: KEY });
    renderPage();
    fill(GOOD, GOOD);
    fireEvent.click(screen.getByRole('button', { name: 'Verschlüsselung einrichten' }));

    const password = await screen.findByLabelText('Aktuelles Passwort');
    fireEvent.change(password, { target: { value: 'mein-passwort' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    expect(await screen.findByLabelText('Wiederherstellungsschlüssel')).toHaveTextContent(KEY);
    expect(vaultSetup).toHaveBeenLastCalledWith(GOOD, { currentPassword: 'mein-passwort' });
  });

  it('zeigt einen Fehler und bleibt im ersten Schritt', async () => {
    vaultSetup.mockRejectedValue(
      new ApiError({ code: 'vault_passphrase_invalid', message: 'Die Passphrase ist zu kurz.' }, 400),
    );
    renderPage();
    fill(GOOD, GOOD);
    fireEvent.click(screen.getByRole('button', { name: 'Verschlüsselung einrichten' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Die Passphrase ist zu kurz.');
    expect(screen.queryByLabelText('Wiederherstellungsschlüssel')).toBeNull();
  });

  it('warnt vor dem Verlassen der Seite, solange der Schlüssel offen ist', async () => {
    vaultSetup.mockResolvedValue({ recoveryKey: KEY });
    renderPage();
    fill(GOOD, GOOD);
    fireEvent.click(screen.getByRole('button', { name: 'Verschlüsselung einrichten' }));
    await screen.findByLabelText('Wiederherstellungsschlüssel');
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('hat keine Barrierefreiheitsverstöße', async () => {
    const { container } = renderPage();
    expect(await axe(container)).toHaveNoViolations();
  });
});
