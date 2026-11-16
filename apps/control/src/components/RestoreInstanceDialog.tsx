import { useEffect, useState } from 'react';
import { FileKey } from 'lucide-react';
import { Button, Dialog, InputField, NoticeBar } from '@saas-instant/ui';
import {
  startInstanceRestore,
  type InstanceBackupRow,
  type InstanceRestore,
  type SecondFactorEvidence,
} from '../lib/api';
import { errorText } from '../lib/api-client';
import { useSecondFactorEvidence } from '../lib/second-factor';
import { formatDate } from '../utils/date';
import { formatSize } from '../utils/size';
import { useT } from '../i18n';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';

/**
 * „Als neue Instanz wiederherstellen".
 *
 * Es entsteht IMMER eine zusätzliche Instanz; die bestehende bleibt
 * unverändert. Der private Schlüssel lebt nur im Zustand dieses Dialogs und
 * wird beim Schließen verworfen. Eine Bestätigung durch Tippen gibt es nicht:
 * Die Wiederherstellung legt immer eine NEUE Instanz an und löscht nie etwas,
 * die alte bleibt unberührt. Die API verlangt den Instanznamen weiterhin
 * (Regel 2 der Projektkonventionen: der Server prüft alles); die Oberfläche
 * schickt dafür den Namen der Instanz, aus der sie geöffnet wurde.
 */

/** Eine Schlüsseldatei ist wenige Zeilen groß; alles darüber ist die falsche Datei. */
const KEY_FILE_MAX_BYTES = 64 * 1024;
export function RestoreInstanceDialog({
  open,
  instanceId,
  subdomain,
  backup,
  totpPossible,
  onClose,
  onStarted,
}: {
  open: boolean;
  instanceId: string;
  /** Der Instanzname der bestehenden Instanz; geht unverändert an den Server. */
  subdomain: string;
  backup: InstanceBackupRow | null;
  totpPossible: boolean;
  onClose: () => void;
  onStarted: (restore: InstanceRestore) => void;
}) {
  const t = useT();
  const evidenceState = useSecondFactorEvidence();
  const [newSubdomain, setNewSubdomain] = useState('');
  const [key, setKey] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  // Beim Schließen alles verwerfen — vor allem den Schlüssel.
  useEffect(() => {
    if (!open) {
      setNewSubdomain('');
      setKey('');
      setFileName(null);
      setDragging(false);
      setError(null);
      setFileError(null);
      setLoading(false);
      evidenceState.close();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const ready = backup !== null && newSubdomain.trim() !== '' && key.trim() !== '';

  async function readFile(file: File | undefined) {
    setFileError(null);
    if (!file) return;
    if (file.size > KEY_FILE_MAX_BYTES) {
      setFileError(t('backup.restoreKeyFileTooBig'));
      return;
    }
    try {
      setKey((await file.text()).trim());
      setFileName(file.name);
    } catch {
      setFileError(t('backup.restoreKeyFileFailed'));
    }
  }

  async function submit(evidence?: SecondFactorEvidence) {
    if (!ready || backup === null) return;
    setLoading(true);
    setError(null);
    try {
      const restore = await startInstanceRestore(
        instanceId,
        {
          backupId: backup.id,
          newSubdomain: newSubdomain.trim(),
          // Dateien enden oft auf einen Zeilenumbruch, und age-Schlüsseldateien
          // können Kommentarzeilen tragen: nur die Schlüsselzeile gilt.
          ageIdentity: keyLine(key),
          confirmName: subdomain,
        },
        evidence,
      );
      evidenceState.close();
      onStarted(restore);
    } catch (e) {
      if (evidenceState.handle(e, evidence)) return;
      setError(errorText(e, t('backup.restoreStartFailed')));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Dialog
        open={open && !evidenceState.open}
        title={t('backup.restoreTitle')}
        size="sm"
        onClose={onClose}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>{t('backup.restoreCancel')}</Button>
            <Button disabled={!ready} loading={loading} onClick={() => void submit()}>
              {newSubdomain.trim() === ''
                ? t('backup.restoreSubmit')
                : t('backup.restoreSubmitNamed', { subdomain: newSubdomain.trim() })}
            </Button>
          </>
        }
      >
        <NoticeBar kind="notice" className="mb-4">{t('backup.restoreExisting')}</NoticeBar>
        {backup !== null && (
          <p className="mb-4 text-sm text-text">
            <span className="font-medium">{t('backup.restoreBackup')}: </span>
            {t('backup.restoreBackupValue', {
              date: formatDate(backup.date),
              size: formatSize(backup.sizeBytes),
            })}
          </p>
        )}
        <InputField
          id="wiederherstellen-subdomain"
          label={t('backup.restoreNewSubdomain')}
          helperText={t('backup.restoreNewSubdomainHint')}
          value={newSubdomain}
          onChange={(e) => setNewSubdomain(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="mb-4 text-left">
          <label htmlFor="wiederherstellen-schluessel" className="mb-1 block text-sm font-medium text-text">
            {t('backup.restoreKey')}
          </label>
          <textarea
            id="wiederherstellen-schluessel"
            rows={3}
            spellCheck={false}
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="w-full rounded-lg border border-rahmen-ui bg-flaeche px-3 py-2 font-mono text-sm text-text placeholder:text-still focus:border-primaer"
          />
          <p className="mt-1 text-sm text-leise">{t('backup.restoreKeyHint')}</p>
          <label
            htmlFor="wiederherstellen-schluesseldatei"
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void readFile(e.dataTransfer.files[0]);
            }}
            className={`mt-2 flex cursor-pointer items-center gap-3 rounded-lg border-2 border-dashed px-3 py-3 text-sm text-text transition-colors focus-within:border-primaer hover:bg-flaeche-3 ${
              dragging ? 'border-primaer bg-primaer-soft' : 'border-rahmen-ui'
            }`}
          >
            <FileKey className="h-5 w-5 shrink-0 text-leise" aria-hidden="true" />
            <span className="min-w-0 break-words">
              {fileName !== null
                ? t('backup.restoreKeyFileChosen', { name: fileName })
                : t('backup.restoreKeyDrop')}
            </span>
            <input
              id="wiederherstellen-schluesseldatei"
              type="file"
              className="sr-only"
              onChange={(e) => {
                void readFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
          {fileError !== null && <p role="alert" className="mt-1 text-sm text-gefahr">{fileError}</p>}
        </div>
        {error !== null && <p role="alert" className="text-sm text-gefahr">{error}</p>}
      </Dialog>

      <SecondFactorEvidenceDialog
        open={open && evidenceState.open}
        title={t('backup.restoreEvidenceTitle')}
        declaration={t('backup.restoreEvidenceReason')}
        totpPossible={totpPossible}
        loading={loading}
        error={evidenceState.error}
        onCancel={evidenceState.close}
        onConfirm={(evidence) => void submit(evidence)}
      />
    </>
  );
}

/** Aus eingefügtem Text oder Datei die Zeile `AGE-SECRET-KEY-1…` holen. */
export function keyLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith('AGE-SECRET-KEY-'));
  return line ?? text.trim();
}
