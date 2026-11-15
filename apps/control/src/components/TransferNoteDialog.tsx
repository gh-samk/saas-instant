import { useEffect, useState } from 'react';
import { Dialog, InputField, Button } from '@saas-instant/ui';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';
import { ApiError, errorText } from '../lib/api-client';
import {
  noteTransfer,
  type Invoice,
  type SecondFactorEvidence,
} from '../lib/api';
import { useT } from '../i18n';

/** Grenze aus `UebertragungDto` (`@MaxLength(80)`). */
const NOTE_MAX_LENGTH = 80;

/**
 * Der Übertragungsvermerk an die Buchhaltung.
 *
 * KEINE lexoffice- und KEINE sevDesk-Schnittstelle — ausdrücklich nicht
 * gebaut. Die Betreiberin überträgt die Belege von Hand und hält hier fest,
 * dass sie es getan hat.
 *
 * FREITEXT OHNE WERTELISTE, weil das Backend `uebertragungsstatus` als freien
 * String führt (kein Enum). Eine feste Liste im UI behauptete eine Struktur,
 * die es dort nicht gibt — und der erste Wert, den jemand tatsächlich braucht,
 * fehlte darin.
 *
 * DERSELBE ZWEITE FAKTOR wie bei der Zahlung, und aus demselben Grund: Ein
 * falscher Vermerk „ist übertragen" hat dieselbe stille Wirkung wie ein
 * falsches „ist bezahlt" — der Beleg verschwindet aus dem, was noch zu tun
 * ist. Beide Routen des `RechnungZahlungController` stehen deshalb hinter
 * demselben Guard.
 */
export function TransferNoteDialog({
  open,
  invoice,
  totpPossible,
  onClose,
  onNoted,
}: {
  open: boolean;
  invoice: Invoice;
  totpPossible: boolean;
  onClose: () => void;
  onNoted: (invoice: Invoice) => void;
}) {
  const t = useT();
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [dialogError, setDialogError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setNote(invoice.transferStatus ?? '');
    setError(null);
    setEvidenceOpen(false);
    setDialogError(undefined);
  }, [open, invoice.transferStatus]);

  async function record(evidence?: SecondFactorEvidence) {
    setLoading(true);
    setError(null);
    try {
      const updated = await noteTransfer(
        invoice.id,
        note.trim(),
        evidence,
      );
      setEvidenceOpen(false);
      onNoted(updated);
    } catch (f) {
      if (f instanceof ApiError && f.status === 401) {
        if (evidence) {
          setDialogError(
            evidence.totpCode !== undefined
              ? t('components.transferNoteDialog.text')
              : t('components.transferNoteDialog.text2'),
          );
        } else {
          setDialogError(undefined);
          setEvidenceOpen(true);
        }
        return;
      }
      setError(errorText(f, t('components.transferNoteDialog.text3')));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Dialog
        open={open}
        title={t('components.transferNoteDialog.title')}
        size="sm"
        onClose={() => {
          if (!loading) onClose();
        }}
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={loading}>
              {t('components.transferNoteDialog.button')}</Button>
            <Button
              form="uebertragung-formular"
              type="submit"
              loading={loading}
              disabled={note.trim().length === 0}
            >
              {t('components.transferNoteDialog.button2')}</Button>
          </>
        }
      >
        <form
          id="uebertragung-formular"
          onSubmit={(ev) => {
            ev.preventDefault();
            void record();
          }}
          noValidate
        >
          <p className="mb-4 text-sm text-leise">
            {t('components.transferNoteDialog.text4')}{invoice.invoiceNumber}{t('components.transferNoteDialog.text5')}</p>
          <InputField
            id="uebertragung-vermerk"
            name="uebertragung-vermerk"
            label={t('components.transferNoteDialog.label')}
            autoComplete="off"
            maxLength={NOTE_MAX_LENGTH}
            value={note}
            disabled={loading}
            onChange={(ev) => setNote(ev.target.value)}
            helperText={t('components.transferNoteDialog.helperText', { NOTE_MAX_LENGTH: NOTE_MAX_LENGTH })}
          />
          {error && (
            <p role="alert" className="mt-2 text-sm text-gefahr">
              {error}
            </p>
          )}
        </form>
      </Dialog>

      <SecondFactorEvidenceDialog
        open={evidenceOpen}
        title={t('components.transferNoteDialog.title')}
        declaration={t('components.transferNoteDialog.declaration')}
        totpPossible={totpPossible}
        loading={loading}
        error={dialogError}
        onCancel={() => {
          setEvidenceOpen(false);
          setDialogError(undefined);
        }}
        onConfirm={(evidence) => void record(evidence)}
      />
    </>
  );
}
