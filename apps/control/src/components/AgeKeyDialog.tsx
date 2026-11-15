import { useEffect, useState } from 'react';
import { Button, Dialog, NoticeBar } from '@saas-instant/ui';
import { useT } from '../i18n';

/**
 * Zeigt den privaten Entschlüsselungsschlüssel GENAU EINMAL nach der
 * Ersteinrichtung. Der Dialog lässt sich nur schließen, wenn bestätigt wurde,
 * dass der Schlüssel sicher abgelegt ist. Er wird nirgends gespeichert.
 */
export function AgeKeyDialog({
  identity,
  onClose,
}: {
  identity: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (identity === null) {
      setConfirmed(false);
      setMessage(null);
    }
  }, [identity]);

  async function copy() {
    if (identity === null) return;
    try {
      await navigator.clipboard.writeText(identity);
      setMessage(t('backup.keyCopied'));
    } catch {
      setMessage(t('backup.keyCopyFailed'));
    }
  }

  function download() {
    if (identity === null) return;
    const url = URL.createObjectURL(new Blob([`${identity}\n`], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'entschluesselungsschluessel.txt';
    link.click();
    URL.revokeObjectURL(url);
  }

  function close() {
    if (!confirmed) return;
    onClose();
  }

  return (
    <Dialog
      open={identity !== null}
      title={t('backup.keyDialogTitle')}
      size="sm"
      onClose={close}
      footer={
        <Button disabled={!confirmed} onClick={close}>
          {t('backup.keyClose')}
        </Button>
      }
    >
      <NoticeBar kind="attention" className="mb-4">{t('backup.keyDialogWarning')}</NoticeBar>
      <label htmlFor="sicherung-age-schluessel" className="mb-1 block text-sm font-medium text-text">
        {t('backup.keyLabel')}
      </label>
      <textarea
        id="sicherung-age-schluessel"
        readOnly
        rows={3}
        value={identity ?? ''}
        className="mb-3 w-full rounded-lg border border-rahmen-ui bg-flaeche px-3 py-2 font-mono text-sm text-text"
      />
      <div className="mb-3 flex flex-wrap gap-3">
        <Button variant="secondary" onClick={() => void copy()}>{t('backup.keyCopy')}</Button>
        <Button variant="secondary" onClick={download}>{t('backup.keyDownload')}</Button>
      </div>
      {message !== null && <p role="status" className="mb-3 text-sm text-leise">{message}</p>}
      <label className="flex items-start gap-2 text-sm text-text">
        <input
          type="checkbox"
          className="mt-1"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        <span>{t('backup.keyConfirm')}</span>
      </label>
    </Dialog>
  );
}
