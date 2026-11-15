import { useEffect, useState } from 'react';
import { Dialog, Button, Skeleton } from '@saas-instant/ui';
import { ConsentEvidence } from './ConsentEvidence';
import { errorText } from '../lib/api-client';
import { fetchEvidence, type Evidence } from '../lib/api';
import { useT } from '../i18n';

/**
 * Der Nachweis zu genau einer Adresse, nachgeladen beim Öffnen.
 *
 * WARUM NACHGELADEN UND NICHT MITGELIEFERT: Die Empfängerauswahl liefert je
 * Zeile nur Adresse, Organisation und Bestätigungsdatum. Der Wortlaut, die
 * beiden IP-Adressen und der Zustand stehen ausschliesslich hinter
 * `GET /api/broadcast/nachweis`. Sie für jede Zeile einer Liste mitzuladen
 * hiesse, den vollständigen Nachweis jeder eingetragenen Person in den Browser
 * zu holen, weil vielleicht jemand nach einer davon fragt.
 *
 * `null` heisst „zu dieser Adresse gibt es keinen Eintrag" und ist kein
 * Fehler: Genau das ist die Antwort, wenn jemand nach einer Adresse fragt, die
 * wir nie hatten — und sie muss sichtbar anders aussehen als ein Ladefehler.
 */
export function ConsentEvidenceDialog({
  open,
  email,
  onClose,
}: {
  open: boolean;
  email: string;
  onClose: () => void;
}) {
  const t = useT();
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || email === '') return;
    let lives = true;
    setLoading(true);
    setError(null);
    setEvidence(null);
    fetchEvidence(email)
      .then((response) => {
        if (lives) setEvidence(response);
      })
      .catch((f: unknown) => {
        if (lives) setError(errorText(f, t('components.consentEvidenceDialog.text')));
      })
      .finally(() => {
        if (lives) setLoading(false);
      });
    return () => {
      lives = false;
    };
  }, [open, email]);

  return (
    <Dialog
      open={open}
      title={t('components.consentEvidenceDialog.title')}
      size="lg"
      onClose={onClose}
      footer={
        // „Fertig" und nicht „Schliessen": Das Schliesskreuz oben rechts trägt
        // bereits die Beschriftung „Schließen", und zwei Knöpfe mit demselben
        // Namen sind für ein Vorleseprogramm zwei gleich klingende Ziele.
        <Button variant="secondary" onClick={onClose}>
          {t('components.consentEvidenceDialog.button')}</Button>
      }
    >
      {loading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : error !== null ? (
        <p role="alert" className="text-sm text-gefahr">
          {error}
        </p>
      ) : evidence === null ? (
        <div>
          <p className="text-sm font-medium text-text">
            {t('components.consentEvidenceDialog.text2')}<span className="break-all">{email}</span> {t('components.consentEvidenceDialog.text3')}</p>
          <p className="mt-1 text-sm text-leise">
            {t('components.consentEvidenceDialog.text4')}</p>
        </div>
      ) : (
        <ConsentEvidence evidence={evidence} />
      )}
    </Dialog>
  );
}
