import { useEffect, useState } from 'react';
import { Dialog, InputField, Button } from '@saas-instant/ui';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';
import { errorText } from '../lib/api-client';
import { useSecondFactorEvidence } from '../lib/second-factor';
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
  // [M12] Der Nachweis läuft über denselben Ablauf wie überall (`ZweitfaktorGuard`
  // lehnt ohne ihn ab, und der Server kennt die Felder jetzt im DTO).
  const evidenceState = useSecondFactorEvidence();

  useEffect(() => {
    if (!open) return;
    setNote(invoice.transferStatus ?? '');
    setError(null);
    evidenceState.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      evidenceState.close();
      onNoted(updated);
    } catch (f) {
      if (evidenceState.handle(f, evidence)) return;
      evidenceState.close();
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
        open={evidenceState.open}
        title={t('components.transferNoteDialog.title')}
        declaration={t('components.transferNoteDialog.declaration')}
        totpPossible={totpPossible}
        loading={loading}
        error={evidenceState.error}
        onCancel={evidenceState.close}
        onConfirm={(evidence) => void record(evidence)}
      />
    </>
  );
}
