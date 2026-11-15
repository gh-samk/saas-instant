import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { axe } from 'vitest-axe';
import * as matchers from 'vitest-axe/matchers';
import { ToastProvider } from '@saas-instant/ui';
import { ApiError } from '../lib/api-client';
import type { BackupSettings } from '../lib/api';
import { BackupSettingsCard, validate, formFrom } from './BackupSettingsCard';
import { t } from '../i18n';

expect.extend(matchers);

const fetchBackupSettings = vi.fn();
const saveBackupSettings = vi.fn();
const testBackupTarget = vi.fn();
vi.mock('../lib/api', () => ({
  fetchBackupSettings: (...a: unknown[]) => fetchBackupSettings(...a),
  saveBackupSettings: (...a: unknown[]) => saveBackupSettings(...a),
  testBackupTarget: (...a: unknown[]) => testBackupTarget(...a),
}));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ reload: vi.fn().mockResolvedValue(undefined), state: { totpSetUp: false } }),
}));

const EMPTY: BackupSettings = {
  target: null,
  agent: { configured: true, reachable: true, version: '1.2.0', targetConfigured: false, objectLock: null, ageRecipient: null },
};
const CONFIGURED: BackupSettings = {
  target: {
    type: 's3', endpoint: 'https://s3.example.com', host: null, bucket: 'sicherung', region: 'eu', path: null,
    port: null, username: null, schedule: 'daily', retentionDays: 30,
    lastTestAt: '2026-11-01T10:00:00.000Z', lastTestOk: true, lastTestMessage: 'ok',
    prefix: 'si/meins', pathStyle: true, authType: null, hostKeyFingerprint: null,
  },
  agent: { configured: true, reachable: true, version: '1.2.0', targetConfigured: true, objectLock: true, ageRecipient: 'age1abc' },
};

function renderCard() {
  return render(<ToastProvider><BackupSettingsCard /></ToastProvider>);
}

async function fillS3() {
  fireEvent.change(await screen.findByLabelText('Endpunkt'), { target: { value: 'https://s3.example.com' } });
  fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'eu' } });
  fireEvent.change(screen.getByLabelText('Bucket'), { target: { value: 'sicherung' } });
  fireEvent.change(screen.getByLabelText('Zugangsschlüssel-ID'), { target: { value: 'AKIA' } });
  fireEvent.change(screen.getByLabelText('Geheimer Schlüssel'), { target: { value: 'geheim' } });
}

describe('BackupSettingsCard', () => {
  beforeEach(() => {
    fetchBackupSettings.mockReset().mockResolvedValue(EMPTY);
    saveBackupSettings.mockReset();
    testBackupTarget.mockReset();
  });

  it('belegt Geheimfelder nie vor und nennt den Platzhalter', async () => {
    fetchBackupSettings.mockResolvedValue(CONFIGURED);
    renderCard();
    const secret = await screen.findByLabelText('Geheimer Schlüssel');
    expect(secret).toHaveValue('');
    expect(secret).toHaveAttribute('placeholder', 'gesetzt – zum Ändern neu eingeben');
    expect(screen.getByLabelText('Zugangsschlüssel-ID')).toHaveValue('');
    expect(screen.getByLabelText('Bucket')).toHaveValue('sicherung');
  });

  it('belegt Präfix und Pfad-Stil aus den gelieferten Werten vor', async () => {
    fetchBackupSettings.mockResolvedValue(CONFIGURED);
    renderCard();
    expect(await screen.findByLabelText('Präfix')).toHaveValue('si/meins');
    expect(screen.getByRole('switch', { name: "Path-Style-Adressierung" })).toBeChecked();
  });

  it('speichert mit gespeichertem Ziel ohne Geheimfelder: leer = unverändert', async () => {
    fetchBackupSettings.mockResolvedValue(CONFIGURED);
    saveBackupSettings.mockResolvedValue(CONFIGURED);
    renderCard();
    await screen.findByLabelText('Bucket');
    expect(screen.getByText(/Leer lassen = unverändert/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(saveBackupSettings).toHaveBeenCalledTimes(1));
    const sent = saveBackupSettings.mock.calls[0]?.[0] as { s3: Record<string, unknown> };
    expect(sent.s3).not.toHaveProperty('accessKeyId');
    expect(sent.s3).not.toHaveProperty('secretAccessKey');
    expect(sent.s3['prefix']).toBe('si/meins');
    expect(sent.s3['pathStyle']).toBe(true);
  });

  it('verlangt beide Geheimfelder zusammen, wenn nur eines ausgefüllt ist', () => {
    const form = { ...formFrom(CONFIGURED), accessKeyId: 'AKIA' };
    expect(validate(form, t, CONFIGURED.target).problems).toContain(
      t('backup.errSecretPair'),
    );
    expect(validate(formFrom(CONFIGURED), t, CONFIGURED.target).problems).toEqual([]);
    // Ohne gespeichertes Ziel bleiben die Geheimfelder Pflicht.
    expect(validate(formFrom(CONFIGURED), t, null).problems.length).toBeGreaterThan(0);
  });

  it('zeigt bei der Storage Box den Host-Key-Fingerabdruck und lässt das Geheimnis leer', async () => {
    const BOX: BackupSettings = {
      ...CONFIGURED,
      target: {
        ...CONFIGURED.target!, type: 'storagebox', endpoint: null, bucket: null, region: null,
        host: 'u1.your-storagebox.de', port: 23, username: 'u1', path: '/b',
        prefix: null, pathStyle: null, authType: 'password', hostKeyFingerprint: 'SHA256:abc123',
      },
    };
    fetchBackupSettings.mockResolvedValue(BOX);
    saveBackupSettings.mockResolvedValue(BOX);
    renderCard();
    expect(await screen.findByTestId('host-key-fingerprint')).toHaveTextContent('SHA256:abc123');
    expect(screen.getByLabelText('Authentifizierung')).toHaveValue('password');
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(saveBackupSettings).toHaveBeenCalledTimes(1));
    const sent = saveBackupSettings.mock.calls[0]?.[0] as { storagebox: Record<string, unknown> };
    expect(sent.storagebox).not.toHaveProperty('password');
    expect(sent.storagebox['authType']).toBe('password');
  });

  it('wechselt die Felder mit dem Ziel-Typ', async () => {
    renderCard();
    fireEvent.change(await screen.findByLabelText('Ziel-Typ'), { target: { value: 'storagebox' } });
    expect(screen.getByLabelText('Host')).toBeInTheDocument();
    expect(screen.getByLabelText('Port')).toHaveValue('23');
    expect(screen.queryByLabelText('Endpunkt')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Authentifizierung'), { target: { value: 'password' } });
    expect(screen.getByLabelText('Passwort')).toBeInTheDocument();
  });

  it('meldet fehlende Pflichtfelder und ruft den Server nicht', async () => {
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText('Die Region fehlt.')).toBeInTheDocument();
    expect(saveBackupSettings).not.toHaveBeenCalled();
  });

  it('speichert und zeigt den Schlüssel einmalig; Schließen erst nach Bestätigung', async () => {
    saveBackupSettings.mockResolvedValue({ ...CONFIGURED, ageIdentity: 'AGE-SECRET-KEY-1ABC' });
    renderCard();
    await fillS3();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await screen.findByText('Entschlüsselungsschlüssel – wird nur jetzt angezeigt');
    expect(screen.getByDisplayValue('AGE-SECRET-KEY-1ABC')).toBeInTheDocument();
    expect(screen.getByText(/ohne diesen Schlüssel ist keine Wiederherstellung möglich/i)).toBeInTheDocument();
    const done = screen.getByRole('button', { name: 'Fertig' });
    expect(done).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Ich habe den Schlüssel sicher abgelegt'));
    expect(done).toBeEnabled();
    fireEvent.click(done);
    await waitFor(() =>
      expect(screen.queryByDisplayValue('AGE-SECRET-KEY-1ABC')).not.toBeInTheDocument(),
    );
    // Geheimfelder sind nach dem Speichern leer.
    expect(screen.getByLabelText('Geheimer Schlüssel')).toHaveValue('');
  });

  it('fragt bei verlangtem Nachweis nach und sendet ihn mit', async () => {
    saveBackupSettings
      .mockRejectedValueOnce(new ApiError({ code: 'login_failed', message: 'x' }, 401))
      .mockResolvedValueOnce(CONFIGURED);
    renderCard();
    await fillS3();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    fireEvent.change(await screen.findByLabelText('Aktuelles Passwort'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(saveBackupSettings).toHaveBeenCalledTimes(2));
    expect(saveBackupSettings.mock.calls[1]?.[1]).toEqual({ currentPassword: 'pw' });
  });

  it('zeigt einen verständlichen Fehler, wenn der Agent nicht erreichbar ist', async () => {
    fetchBackupSettings.mockRejectedValue(
      new ApiError({ code: 'backup_agent_unavailable', message: 'roh' }, 503),
    );
    renderCard();
    expect(await screen.findByText(/Sicherungs-Agent ist nicht erreichbar/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeInTheDocument();
  });

  it('testet die Verbindung und zeigt das Ergebnis', async () => {
    fetchBackupSettings.mockResolvedValue(CONFIGURED);
    testBackupTarget.mockResolvedValue({ ok: false, message: 'Zugriff verweigert', testedAt: '2026-11-02T10:00:00.000Z' });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Verbindung testen' }));
    expect(await screen.findByText(/Verbindung fehlgeschlagen: Zugriff verweigert/)).toBeInTheDocument();
  });

  it('validate: Storage Box braucht den passenden Zugang', () => {
    const form = { ...formFrom(null), type: 'storagebox' as const, host: 'box.example.com', username: 'u1', path: '/b' };
    expect(validate(form, t).problems).toContain('Der private SSH-Schlüssel fehlt.');
    const ok = validate({ ...form, privateKey: 'KEY' }, t);
    expect(ok.input?.storagebox?.privateKey).toBe('KEY');
    expect(ok.input?.objectLock).toBe(false);
  });

  it('hat keine Barrierefreiheitsverstöße', async () => {
    const { container } = renderCard();
    await screen.findByLabelText('Endpunkt');
    expect(await axe(container)).toHaveNoViolations();
  });
});
