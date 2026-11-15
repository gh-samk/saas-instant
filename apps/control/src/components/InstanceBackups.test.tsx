import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { axe } from 'vitest-axe';
import * as matchers from 'vitest-axe/matchers';
import { ToastProvider } from '@saas-instant/ui';
import { ApiError } from '../lib/api-client';
import type { InstanceBackupRow, InstanceRestore } from '../lib/api';
import { InstanceBackups } from './InstanceBackups';
import { RestoreStatus } from './RestoreStatus';
import { keyLine } from './RestoreInstanceDialog';

expect.extend(matchers);

const fetchInstanceBackups = vi.fn();
const startInstanceBackup = vi.fn();
const fetchBackupJob = vi.fn();
const fetchInstanceRestores = vi.fn();
const startInstanceRestore = vi.fn();
const adoptInstanceRestore = vi.fn();
vi.mock('../lib/api', () => ({
  fetchInstanceBackups: (...a: unknown[]) => fetchInstanceBackups(...a),
  startInstanceBackup: (...a: unknown[]) => startInstanceBackup(...a),
  fetchBackupJob: (...a: unknown[]) => fetchBackupJob(...a),
  fetchInstanceRestores: (...a: unknown[]) => fetchInstanceRestores(...a),
  startInstanceRestore: (...a: unknown[]) => startInstanceRestore(...a),
  adoptInstanceRestore: (...a: unknown[]) => adoptInstanceRestore(...a),
}));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ reload: vi.fn().mockResolvedValue(undefined), state: { totpSetUp: false } }),
}));

const BACKUP: InstanceBackupRow = {
  id: '11111111-1111-4111-8111-111111111111',
  date: '2026-11-01',
  sizeBytes: 2.4 * 1024 ** 3,
  objectKey: 'k',
  sha256: 'abc',
  verified: true,
  verifiedAt: '2026-11-02T10:00:00.000Z',
  restorable: true,
};

const RESTORE: InstanceRestore = {
  id: 'r1', instanceId: 'i1', backupId: BACKUP.id, newSubdomain: 'verein-neu',
  status: 'ready', message: null, createdAt: '2026-11-03T10:00:00.000Z', adoptedAt: null,
};

const KEY = 'AGE-SECRET-KEY-1' + 'A'.repeat(50);

function show(onAdopted?: () => void) {
  return render(
    <ToastProvider>
      <InstanceBackups instanceId="i1" subdomain="verein-alt" totpPossible={false} pollMs={20} onAdopted={onAdopted} />
    </ToastProvider>,
  );
}

describe('InstanceBackups', () => {
  beforeEach(() => {
    fetchInstanceBackups.mockReset().mockResolvedValue({ backups: [BACKUP] });
    fetchInstanceRestores.mockReset().mockResolvedValue([]);
    startInstanceBackup.mockReset();
    fetchBackupJob.mockReset();
    startInstanceRestore.mockReset();
    adoptInstanceRestore.mockReset();
  });

  it('listet Sicherungen mit Datum, Art, Größe und Prüfstand', async () => {
    show();
    expect(await screen.findByText('01.11.2026')).toBeInTheDocument();
    expect(screen.getByText('2,4 GB')).toBeInTheDocument();
    expect(screen.getAllByText('Geprüft')).toHaveLength(2); // Spaltenkopf und Zelle
  });

  it('„Jetzt sichern" zeigt den Jobstatus bis zum Ende und lädt die Liste neu', async () => {
    startInstanceBackup.mockResolvedValue({ jobId: 'job-12345678' });
    fetchBackupJob.mockResolvedValue({ id: 'job-12345678', kind: 'backup', status: 'succeeded', startedAt: null, finishedAt: null, message: null, result: null });
    show();
    await screen.findByText('01.11.2026');
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt sichern' }));
    expect(await screen.findByText('Die Sicherung wartet auf den Start.')).toBeInTheDocument();
    expect(await screen.findByText('Die Sicherung ist fertig.')).toBeInTheDocument();
    await waitFor(() => expect(fetchInstanceBackups).toHaveBeenCalledTimes(2));
  });

  it('zeigt einen fehlgeschlagenen Auftrag mit Grund', async () => {
    startInstanceBackup.mockResolvedValue({ jobId: 'job-12345678' });
    fetchBackupJob.mockResolvedValue({ id: 'job-12345678', kind: 'backup', status: 'failed', startedAt: null, finishedAt: null, message: 'Ziel voll', result: null });
    show();
    await screen.findByText('01.11.2026');
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt sichern' }));
    expect(await screen.findByText('Die Sicherung ist fehlgeschlagen: Ziel voll')).toBeInTheDocument();
  });

  it('meldet verständlich, wenn der Agent nicht erreichbar ist', async () => {
    startInstanceBackup.mockRejectedValue(
      new ApiError({ code: 'backup_agent_unavailable', message: 'Der Sicherungs-Agent ist nicht erreichbar. Es wurde nichts verändert.' }, 503),
    );
    show();
    await screen.findByText('01.11.2026');
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt sichern' }));
    expect(await screen.findByText(/Sicherungs-Agent ist nicht erreichbar/)).toBeInTheDocument();
  });

  it('Wiederherstellen: Bestätigung erst bei richtigem Instanznamen, Schlüssel geht an den Server', async () => {
    startInstanceRestore.mockResolvedValue({ ...RESTORE, status: 'provisioning' });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Als neue Instanz wiederherstellen' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/bestehende Instanz bleibt unverändert/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Neue Subdomain'), { target: { value: 'verein-neu' } });
    fireEvent.change(within(dialog).getByLabelText('Privater Schlüssel (Entschlüsselung)'), { target: { value: `# Kommentar\n${KEY}\n` } });
    const submit = within(dialog).getByRole('button', { name: 'Wiederherstellung starten' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Instanzname zur Bestätigung eintippen'), { target: { value: 'falsch' } });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Instanzname zur Bestätigung eintippen'), { target: { value: 'verein-alt' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(startInstanceRestore).toHaveBeenCalled());
    expect(startInstanceRestore.mock.calls[0]?.[1]).toEqual({
      backupId: BACKUP.id, newSubdomain: 'verein-neu', ageIdentity: KEY, confirmName: 'verein-alt',
    });
    expect(await screen.findByText('Neue Instanz verein-neu')).toBeInTheDocument();
    // Der Schlüssel steht nirgends mehr im Dokument.
    expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument();
  });

  it('Übernehmen erklärt „gestoppt, nicht gelöscht" und verlangt den Nachweis', async () => {
    fetchInstanceRestores.mockResolvedValue([RESTORE]);
    adoptInstanceRestore.mockResolvedValue({ ...RESTORE, status: 'adopted' });
    const onAdopted = vi.fn();
    show(onAdopted);
    fireEvent.click(await screen.findByRole('button', { name: 'Übernehmen' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/gestoppt, nicht gelöscht/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Aktuelles Passwort'), { target: { value: 'pw' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(adoptInstanceRestore).toHaveBeenCalledWith('i1', 'r1', { currentPassword: 'pw' }));
    await waitFor(() => expect(onAdopted).toHaveBeenCalled());
  });

  it('hat keine Barrierefreiheitsverstöße', async () => {
    fetchInstanceRestores.mockResolvedValue([RESTORE]);
    const { container } = show();
    await screen.findByText('01.11.2026');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('RestoreStatus', () => {
  it('zeigt den Fortschritt und bietet Übernehmen nur bei „bereit"', () => {
    const { rerender } = render(<ul><RestoreStatus restore={{ ...RESTORE, status: 'restoring' }} onAdopt={vi.fn()} /></ul>);
    expect(screen.getByText('Daten werden eingespielt', { selector: 'span' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Übernehmen' })).not.toBeInTheDocument();
    rerender(<ul><RestoreStatus restore={{ ...RESTORE, status: 'failed', message: 'Schlüssel falsch' }} onAdopt={vi.fn()} /></ul>);
    expect(screen.getByRole('alert')).toHaveTextContent('Schlüssel falsch');
    expect(screen.queryByRole('button', { name: 'Übernehmen' })).not.toBeInTheDocument();
  });
});

describe('keyLine', () => {
  it('nimmt die Schlüsselzeile aus einer Datei mit Kommentaren', () => {
    expect(keyLine(`# created\n# public key: age1x\n${KEY}\n`)).toBe(KEY);
    expect(keyLine('  irgendwas  ')).toBe('irgendwas');
  });
});
