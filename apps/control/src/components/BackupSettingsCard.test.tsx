import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { axe } from 'vitest-axe';
import * as matchers from 'vitest-axe/matchers';
import { ToastProvider } from '@saas-instant/ui';
import { ApiError } from '../lib/api-client';
import type { BackupSettings } from '../lib/api';
import { BackupSettingsCard, validate, formFrom, detectProvider } from './BackupSettingsCard';
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

const HETZNER: BackupSettings = {
  ...CONFIGURED,
  target: {
    ...CONFIGURED.target!, endpoint: 'https://nbg1.your-objectstorage.com', region: 'nbg1',
    prefix: null, pathStyle: false, retentionDays: 30,
  },
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
    testBackupTarget.mockResolvedValue({ ok: true, message: 'ok', testedAt: 'x' });
    renderCard();
    await screen.findByLabelText('Bucket');
    expect(screen.getByText(/Leer lassen = unverändert/)).toBeInTheDocument();
    // Region ändern: Endpunkt und Bucket bleiben, also dürfen die Geheimnisse leer bleiben.
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'eu2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern und testen' }));
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
    testBackupTarget.mockResolvedValue({ ok: true, message: 'ok', testedAt: 'x' });
    renderCard();
    expect(await screen.findByTestId('host-key-fingerprint')).toHaveTextContent('SHA256:abc123');
    expect(screen.getByLabelText('Authentifizierung')).toHaveValue('password');
    fireEvent.change(screen.getByLabelText('Pfad'), { target: { value: '/c' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern und testen' }));
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
    fireEvent.change(await screen.findByLabelText('Bucket'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern und testen' }));
    expect(await screen.findByText('Die Region fehlt.')).toBeInTheDocument();
    expect(saveBackupSettings).not.toHaveBeenCalled();
  });

  it('speichert und zeigt den Schlüssel einmalig; Schließen erst nach Bestätigung', async () => {
    saveBackupSettings.mockResolvedValue({ ...CONFIGURED, ageIdentity: 'AGE-SECRET-KEY-1ABC' });
    testBackupTarget.mockResolvedValue({ ok: true, message: 'ok', testedAt: 'x' });
    renderCard();
    await fillS3();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern und testen' }));
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
    testBackupTarget.mockResolvedValue({ ok: true, message: 'ok', testedAt: 'x' });
    renderCard();
    await fillS3();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern und testen' }));
    fireEvent.change(await screen.findByLabelText('Aktuelles Passwort'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(saveBackupSettings).toHaveBeenCalledTimes(2));
    expect(saveBackupSettings.mock.calls[1]?.[1]).toEqual({ currentPassword: 'pw' });
    await waitFor(() => expect(testBackupTarget).toHaveBeenCalledWith({ currentPassword: 'pw' }));
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
    fireEvent.click(await screen.findByRole('button', { name: 'Verbindung erneut testen' }));
    expect(await screen.findByText(/Verbindung fehlgeschlagen: Zugriff verweigert/)).toBeInTheDocument();
  });

  it('Anbieter-Vorlage Hetzner füllt Endpunkt, Region und Path-Style und folgt dem Standort', async () => {
    renderCard();
    fireEvent.change(await screen.findByLabelText('Anbieter'), { target: { value: 'hetzner' } });
    expect(screen.getByLabelText('Endpunkt')).toHaveValue('https://fsn1.your-objectstorage.com');
    expect(screen.getByLabelText('Standort')).toHaveValue('fsn1');
    fireEvent.change(screen.getByLabelText('Standort'), { target: { value: 'hel1' } });
    expect(screen.getByLabelText('Endpunkt')).toHaveValue('https://hel1.your-objectstorage.com');
  });

  it('Vorlagen AWS und MinIO setzen Endpunkt, Region und Path-Style', async () => {
    renderCard();
    fireEvent.change(await screen.findByLabelText('Anbieter'), { target: { value: 'aws' } });
    expect(screen.getByLabelText('Region')).toHaveValue('eu-central-1');
    expect(screen.getByLabelText('Endpunkt')).toHaveValue('https://s3.eu-central-1.amazonaws.com');
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'eu-west-1' } });
    expect(screen.getByLabelText('Endpunkt')).toHaveValue('https://s3.eu-west-1.amazonaws.com');
    fireEvent.change(screen.getByLabelText('Anbieter'), { target: { value: 'minio' } });
    expect(screen.getByLabelText('Endpunkt')).toHaveValue('');
    expect(screen.getByLabelText('Region')).toHaveValue('eu-west-1');
    // Path-Style ist an, also weicht nichts ab; Erweitert bleibt zu, bis man es öffnet.
    fireEvent.click(screen.getByRole('button', { name: 'Erweitert' }));
    expect(screen.getByRole('switch', { name: 'Path-Style-Adressierung' })).toBeChecked();
  });

  it('erkennt die Vorlage beim Laden aus den Werten', async () => {
    expect(detectProvider('https://nbg1.your-objectstorage.com', 'nbg1', false)).toBe('hetzner');
    expect(detectProvider('https://s3.eu-west-1.amazonaws.com', 'eu-west-1', false)).toBe('aws');
    expect(detectProvider('https://m.example.com', 'us-east-1', true)).toBe('minio');
    expect(detectProvider('https://x.example.com', 'eu', false)).toBe('other');
    fetchBackupSettings.mockResolvedValue(HETZNER);
    renderCard();
    expect(await screen.findByLabelText('Anbieter')).toHaveValue('hetzner');
    expect(screen.getByLabelText('Standort')).toHaveValue('nbg1');
  });

  it('klappt Erweitert zu, wenn alles der Vorgabe entspricht, und auf, wenn ein Wert abweicht', async () => {
    fetchBackupSettings.mockResolvedValue(HETZNER);
    const first = renderCard();
    const toggle = await screen.findByRole('button', { name: 'Erweitert' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Präfix')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByLabelText('Präfix')).toBeInTheDocument();
    expect(screen.getByLabelText('Aufbewahrung in Tagen')).toBeInTheDocument();
    first.unmount();
    fetchBackupSettings.mockResolvedValue(CONFIGURED);
    renderCard();
    expect(await screen.findByLabelText('Präfix')).toHaveValue('si/meins');
    expect(screen.getByRole('button', { name: 'Erweitert' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('klappt Erweitert bei einem Fehler darin auf', async () => {
    fetchBackupSettings.mockResolvedValue(HETZNER);
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Erweitert' }));
    fireEvent.change(screen.getByLabelText('Aufbewahrung in Tagen'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern und testen' }));
    expect(await screen.findByText('Die Aufbewahrung muss zwischen 1 und 3650 Tagen liegen.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Erweitert' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('speichert erst, testet dann, und zeigt das Ergebnis', async () => {
    const order: string[] = [];
    saveBackupSettings.mockImplementation(async () => { order.push('save'); return CONFIGURED; });
    testBackupTarget.mockImplementation(async () => { order.push('test'); return { ok: true, message: 'läuft', testedAt: 'x' }; });
    renderCard();
    await fillS3();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern und testen' }));
    expect(await screen.findByText(/Verbindung erfolgreich: läuft/)).toBeInTheDocument();
    expect(order).toEqual(['save', 'test']);
  });

  it('fragt den Nachweis erst beim Test ab und wiederholt dann nur den Test', async () => {
    saveBackupSettings.mockResolvedValue(CONFIGURED);
    testBackupTarget
      .mockRejectedValueOnce(new ApiError({ code: 'login_failed', message: 'x' }, 401))
      .mockResolvedValueOnce({ ok: true, message: 'ok', testedAt: 'x' });
    renderCard();
    await fillS3();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern und testen' }));
    fireEvent.change(await screen.findByLabelText('Aktuelles Passwort'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(testBackupTarget).toHaveBeenCalledTimes(2));
    expect(saveBackupSettings).toHaveBeenCalledTimes(1);
  });

  it('zeigt die Speicherleiste nur bei Änderungen und Verwerfen setzt zurück', async () => {
    fetchBackupSettings.mockResolvedValue(HETZNER);
    renderCard();
    await screen.findByLabelText('Bucket');
    expect(screen.queryByRole('button', { name: 'Speichern und testen' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Bucket'), { target: { value: 'anders' } });
    expect(screen.getByText('Ungespeicherte Änderungen')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Verwerfen' }));
    expect(screen.getByLabelText('Bucket')).toHaveValue('sicherung');
    expect(screen.queryByRole('button', { name: 'Speichern und testen' })).not.toBeInTheDocument();
  });

  it('validate: geänderte Gegenstelle übernimmt keine gespeicherten Geheimnisse (S3: Endpunkt, Bucket; Box: Host, Port, Benutzer)', () => {
    const s3 = formFrom(CONFIGURED);
    expect(validate(s3, t, CONFIGURED.target).problems).toEqual([]);
    expect(validate({ ...s3, bucket: 'anderer' }, t, CONFIGURED.target).problems).toContain(t('backup.errSecretAgain'));
    expect(validate({ ...s3, endpoint: 'https://fremd.example.com' }, t, CONFIGURED.target).problems).toContain(t('backup.errSecretAgain'));
    expect(validate({ ...s3, bucket: 'anderer', accessKeyId: 'A', secretAccessKey: 'B' }, t, CONFIGURED.target).problems).toEqual([]);

    const box = { ...CONFIGURED.target!, type: 'storagebox' as const, endpoint: null, bucket: null, region: null, host: 'u1.your-storagebox.de', port: 23, username: 'u1', path: '/b', prefix: null, pathStyle: null, authType: 'password' as const };
    const form = { ...formFrom({ ...CONFIGURED, target: box }) };
    expect(validate(form, t, box).problems).toEqual([]);
    for (const change of [{ host: 'fremd.example.com' }, { port: '2222' }, { username: 'anderer' }]) {
      expect(validate({ ...form, ...change }, t, box).problems).toContain(t('backup.errSecretAgain'));
    }
    expect(validate({ ...form, host: 'neu.example.com', password: 'neu' }, t, box).problems).toEqual([]);
  });

  it('validate: Host-Fingerabdruck optional, mit Formatprüfung, und wird mitgesendet', () => {
    const form = { ...formFrom(null), type: 'storagebox' as const, host: 'box.example.com', username: 'u1', path: '/b', privateKey: 'KEY' };
    const fp = 'SHA256:' + 'A'.repeat(43);
    expect(validate(form, t).input?.storagebox).not.toHaveProperty('hostKeyFingerprint');
    expect(validate({ ...form, hostKeyFingerprint: fp }, t).input?.storagebox?.hostKeyFingerprint).toBe(fp);
    expect(validate({ ...form, hostKeyFingerprint: 'MD5:00' }, t).problems).toContain(t('backup.errHostKey'));
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
