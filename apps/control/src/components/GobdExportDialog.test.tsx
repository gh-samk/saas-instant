import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as matchers from 'vitest-axe/matchers';
import { ToastProvider } from '@saas-instant/ui';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { ApiError } from '../lib/api-client';
import { GobdExportDialog } from './GobdExportDialog';

expect.extend(matchers);

const downloadGobdExport = vi.fn();
vi.mock('../lib/api', () => ({
  downloadGobdExport: (...a: unknown[]) => downloadGobdExport(...a),
}));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ reload: vi.fn().mockResolvedValue(undefined), state: { totpSetUp: false } }),
}));

function renderDialog(onClose = vi.fn()) {
  return render(
    <ToastProvider>
      <GobdExportDialog open totpPossible={false} onClose={onClose} />
    </ToastProvider>,
  );
}

describe('GobdExportDialog', () => {
  beforeEach(() => {
    downloadGobdExport.mockReset();
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    HTMLAnchorElement.prototype.click = vi.fn();
  });

  it('zeigt den Hinweis „keine Rechtsberatung" und ist barrierefrei', async () => {
    renderDialog();
    expect(screen.getByText('Technischer Export, keine Rechtsberatung.')).toBeInTheDocument();
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('lädt den Zeitraum und schließt danach', async () => {
    downloadGobdExport.mockResolvedValue({ blob: new Blob(['z']), fileName: 'a.zip' });
    const onClose = vi.fn();
    renderDialog(onClose);
    fireEvent.change(screen.getByLabelText('Von'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('Bis'), { target: { value: '2026-06-30' } });
    fireEvent.click(screen.getByRole('button', { name: /Archiv herunterladen/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(downloadGobdExport).toHaveBeenCalledWith(
      { from: '2026-01-01', to: '2026-06-30' },
      undefined,
    );
  });

  it('sperrt den Download bei umgekehrtem Zeitraum', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Von'), { target: { value: '2026-12-31' } });
    fireEvent.change(screen.getByLabelText('Bis'), { target: { value: '2026-01-01' } });
    expect(screen.getByRole('button', { name: /Archiv herunterladen/ })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/gültigen Zeitraum/);
  });

  it('fragt den Nachweis nach und wiederholt damit', async () => {
    downloadGobdExport
      .mockRejectedValueOnce(
        new ApiError({ code: 'login_failed', message: 'Nachweis nötig' }, 401),
      )
      .mockResolvedValueOnce({ blob: new Blob(['z']), fileName: null });
    const onClose = vi.fn();
    renderDialog(onClose);
    fireEvent.click(screen.getByRole('button', { name: /Archiv herunterladen/ }));
    const password = await screen.findByLabelText(/Passwort/);
    fireEvent.change(password, { target: { value: 'geheim' } });
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(downloadGobdExport).toHaveBeenLastCalledWith(
      expect.any(Object),
      { currentPassword: 'geheim' },
    );
  });
});
