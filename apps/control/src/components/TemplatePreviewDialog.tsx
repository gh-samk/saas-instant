import { useEffect, useState } from 'react';
import { Dialog, Button, Skeleton } from '@saas-instant/ui';
import { BroadcastPreview } from './BroadcastPreview';
import { errorText } from '../lib/api-client';
import { fetchPreview, type MailChannel, type Preview } from '../lib/api';
import { useT } from '../i18n';

/**
 * Die Vorschau einer Vorlage, ohne die Vorlagenseite zu verlassen.
 *
 * WARUM ÜBERHAUPT HIER: In einer Liste von Vorlagen ist „wie sieht die
 * eigentlich aus?" die häufigste Frage, und der Weg dorthin war bisher ein
 * Seitenwechsel und zurück. Der Entwurf setzt dafür ein Auge in die
 * Aktionsspalte.
 *
 * SIE LÄDT ERST BEIM ÖFFNEN. Vier Vorschauen im Voraus zu holen hiesse, vier
 * vollständige Maildokumente zu bauen, von denen man keines ansieht.
 *
 * SIE VERSCHICKT NICHTS UND ÄNDERT NICHTS. Der Endpunkt dahinter ist rein
 * lesend und setzt erkennbare Beispielwerte ein; der Abmeldelink darin ist
 * ein Platzhalter und kein Token einer echten Empfängerin.
 */
export function TemplatePreviewDialog({
  templateId,
  name,
  channel,
  onClose,
}: {
  /** `null` heisst geschlossen — dann wird auch nichts geladen. */
  templateId: string | null;
  name: string;
  channel: MailChannel;
  onClose: () => void;
}) {
  const t = useT();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (templateId === null) return;
    let lives = true;
    setPreview(null);
    setError(null);
    void fetchPreview(templateId)
      .then((v) => {
        if (lives) setPreview(v);
      })
      .catch((f: unknown) => {
        if (lives) {
          setError(errorText(f, t('components.templatePreviewDialog.text')));
        }
      });
    return () => {
      lives = false;
    };
  }, [templateId]);

  return (
    <Dialog
      open={templateId !== null}
      title={t('components.templatePreviewDialog.title', { name })}
      size="lg"
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('components.templatePreviewDialog.button')}</Button>
      }
    >
      {error !== null ? (
        <p role="alert" className="text-sm text-gefahr">
          {error}
        </p>
      ) : preview === null ? (
        <Skeleton className="h-64 w-full rounded-xl" />
      ) : (
        <BroadcastPreview preview={preview} channel={channel} />
      )}
    </Dialog>
  );
}
