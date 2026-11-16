import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as matchers from 'vitest-axe/matchers';
import { ToastProvider } from '@saas-instant/ui';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { ApiError } from '../lib/api-client';
import type { VaultEntry } from '../lib/api';
import { VaultSecurityCard } from './VaultSecurityCard';

expect.extend(matchers);

const fetchVaultEntries = vi.fn();
const vaultAddPassphrase = vi.fn();
const vaultChangePassphrase = vi.fn();
const vaultRegenerateRecovery = vi.fn();
vi.mock('../lib/api', () => ({
  fetchVaultEntries: (...a: unknown[]) => fetchVaultEntries(...a),
  vaultAddPassphrase: (...a: unknown[]) => vaultAddPassphrase(...a),
  vaultChangePassphrase: (...a: unknown[]) => vaultChangePassphrase(...a),
  vaultRegenerateRecovery: (...a: unknown[]) => vaultRegenerateRecovery(...a),
}));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    reload: vi.fn().mockResolvedValue(undefined),
    state: { totpSetUp: true, user: { id: 'u1' } },
  }),
}));

const ENTRIES: VaultEntry[] = [
  { id: 'p1', kind: 'passphrase', label: 'Alex', userId: 'u1', createdAt: '2026-11-01T10:00:00.000Z' },
  { id: 'r1', kind: 'recovery', label: 'Wiederherstellungsschlüssel', userId: null, createdAt: '2026-11-01T10:00:00.000Z' },
];
const NEW_PASS = 'eine neue lange passphrase';
const NEED_EVIDENCE = () => new ApiError({ code: 'login_failed', message: 'Nachweis nötig.' }, 401);

function renderCard() {
  return render(
    <ToastProvider>
      <VaultSecurityCard />
    </ToastProvider>,
  );
}

describe('VaultSecurityCard', () => {
  beforeEach(() => {
    fetchVaultEntries.mockReset().mockResolvedValue(ENTRIES);
    vaultAddPassphrase.mockReset();
    vaultChangePassphrase.mockReset();
    vaultRegenerateRecovery.mockReset();
  });

  it('zeigt Status, Passphrasen und Wiederherstellungsschlüssel mit Aktionen', async () => {
    renderCard();
    expect(await screen.findByText('Passphrase von Alex')).toBeInTheDocument();
    expect(screen.getByText('Entsperrt')).toBeInTheDocument();
    expect(screen.getByText(/· du/)).toBeInTheDocument();
    expect(screen.getByText('Wiederherstellungsschlüssel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Passphrase von Alex ändern' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Wiederherstellungsschlüssel neu erzeugen' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Weitere Passphrase hinzufügen' })).toBeInTheDocument();
  });

  it('zeigt die unbenannte erste Passphrase ohne doppeltes „Passphrase von Passphrase“', async () => {
    fetchVaultEntries.mockResolvedValue([
      { id: 'p0', kind: 'passphrase', label: 'Passphrase', userId: 'u1', createdAt: '2026-11-01T10:00:00.000Z' },
    ]);
    renderCard();
    expect(await screen.findByText(/^Passphrase$/)).toBeInTheDocument();
    expect(screen.queryByText(/Passphrase von Passphrase/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Passphrase ändern' })).toBeInTheDocument();
  });

  it('meldet einen Ladefehler und bietet erneutes Laden an', async () => {
    fetchVaultEntries.mockRejectedValueOnce(new Error('x'));
    renderCard();
    expect(await screen.findByRole('alert')).toHaveTextContent('Der Stand der Verschlüsselung ließ sich nicht laden.');
    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByText('Passphrase von Alex')).toBeInTheDocument();
  });

  it('ändert eine Passphrase und verlangt dafür den zweiten Faktor', async () => {
    vaultChangePassphrase.mockRejectedValueOnce(NEED_EVIDENCE()).mockResolvedValueOnce({ ok: true });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Passphrase von Alex ändern' }));

    const dialog = screen.getByRole('dialog', { name: 'Passphrase ändern' });
    const submit = within(dialog).getByRole('button', { name: 'Passphrase ändern' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Bisherige Passphrase'), { target: { value: 'die alte passphrase' } });
    fireEvent.change(within(dialog).getByLabelText('Neue Passphrase'), { target: { value: NEW_PASS } });
    fireEvent.change(within(dialog).getByLabelText('Passphrase wiederholen'), { target: { value: NEW_PASS } });
    fireEvent.click(submit);

    const evidence = await screen.findByLabelText('Aktuelles Passwort');
    fireEvent.change(evidence, { target: { value: 'mein-passwort' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    await waitFor(() =>
      expect(vaultChangePassphrase).toHaveBeenLastCalledWith('p1', 'die alte passphrase', NEW_PASS, {
        currentPassword: 'mein-passwort',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('nennt eine falsche bisherige Passphrase im Dialog', async () => {
    vaultChangePassphrase.mockRejectedValue(
      new ApiError({ code: 'vault_wrong_secret', message: 'technisch' }, 401),
    );
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Passphrase von Alex ändern' }));
    const dialog = screen.getByRole('dialog', { name: 'Passphrase ändern' });
    fireEvent.change(within(dialog).getByLabelText('Bisherige Passphrase'), { target: { value: 'falsch falsch falsch' } });
    fireEvent.change(within(dialog).getByLabelText('Neue Passphrase'), { target: { value: NEW_PASS } });
    fireEvent.change(within(dialog).getByLabelText('Passphrase wiederholen'), { target: { value: NEW_PASS } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Passphrase ändern' }));
    expect(await within(dialog).findByText('Die bisherige Passphrase stimmt nicht.')).toBeInTheDocument();
    // Kein Nachweisdialog: Der Fehler gehört zur Eingabe, nicht zum Nachweis.
    expect(screen.queryByLabelText('Aktuelles Passwort')).toBeNull();
  });

  it('fügt eine weitere Passphrase mit Bezeichnung hinzu', async () => {
    vaultAddPassphrase.mockResolvedValue({ ...ENTRIES[0], id: 'p2', label: 'Sam' });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Weitere Passphrase hinzufügen' }));
    const dialog = screen.getByRole('dialog', { name: 'Weitere Passphrase hinzufügen' });
    fireEvent.change(within(dialog).getByLabelText('Bezeichnung (optional)'), { target: { value: 'Sam' } });
    fireEvent.change(within(dialog).getByLabelText('Passphrase'), { target: { value: NEW_PASS } });
    fireEvent.change(within(dialog).getByLabelText('Passphrase wiederholen'), { target: { value: NEW_PASS } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hinzufügen' }));
    await waitFor(() => expect(vaultAddPassphrase).toHaveBeenCalledWith(NEW_PASS, 'Sam', undefined));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Liste wird neu geladen.
    expect(fetchVaultEntries).toHaveBeenCalledTimes(2);
  });

  it('erzeugt den Schlüssel neu, zeigt ihn einmal und schließt erst mit dem Häkchen', async () => {
    vaultRegenerateRecovery.mockRejectedValueOnce(NEED_EVIDENCE()).mockResolvedValueOnce({
      recoveryKey: 'NEUERKEY-12345678',
    });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Wiederherstellungsschlüssel neu erzeugen' }));
    const dialog = screen.getByRole('dialog', { name: 'Wiederherstellungsschlüssel neu erzeugen' });
    expect(within(dialog).getByText(/verliert sofort seine Gültigkeit/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Neu erzeugen' }));

    fireEvent.change(await screen.findByLabelText('Aktuelles Passwort'), { target: { value: 'mein-passwort' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    expect(await screen.findByLabelText('Wiederherstellungsschlüssel', { selector: 'p' })).toHaveTextContent('NEUERKEY-12345678');
    expect(vaultRegenerateRecovery).toHaveBeenLastCalledWith({ currentPassword: 'mein-passwort' });

    const done = screen.getByRole('button', { name: 'Neuen Schlüssel gesichert' });
    expect(done).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Ich habe den Schlüssel sicher verwahrt.'));
    expect(done).toBeEnabled();
    fireEvent.click(done);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('hat keine Barrierefreiheitsverstöße', async () => {
    const { container } = renderCard();
    await screen.findByText('Passphrase von Alex');
    expect(await axe(container)).toHaveNoViolations();
  });
});
