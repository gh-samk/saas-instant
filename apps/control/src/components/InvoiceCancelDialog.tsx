import { useEffect, useState } from 'react';
import { Dialog, Button } from '@saas-instant/ui';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';
import { errorText } from '../lib/api-client';
import { useSecondFactorEvidence } from '../lib/second-factor';
import {
  cancelInvoice,
  type Invoice,
  type SecondFactorEvidence,
} from '../lib/api';
import { useT } from '../i18n';

/**
 * Storno — das PAAR, nicht das Löschen.
 *
 * Dasselbe „Das passiert / Das passiert nicht"-Muster wie
 * `InstanzArchivierenDialog` und `KontaktdatenLoeschenDialog`: an dieser
 * Stelle zum dritten Mal, also ein wiedererkennbares Muster für „unumkehrbar,
 * aber transparent".
 *
 * MIT ZWEITEM FAKTOR, wie beim Festschreiben und aus demselben Grund: Der
 * Vorgang lässt sich NICHT ZURÜCKNEHMEN. Hier stand früher das Gegenteil,
 * begründet damit, ein Storno hinterlasse zwei Belege und sei deshalb „nicht
 * still". Das trifft zu und trägt trotzdem nicht: Der Beleg macht den Schaden
 * nicht kleiner, er dokumentiert ihn nur. Eine aufgehobene Forderung ist
 * aufgehoben, und mit einem eine Stunde alten Sitzungs-Cookie waren das
 * 600 Stornos in der Stunde.
 *
 * Der Nachweis-Dialog geht nur auf, wenn der Server ihn verlangt — bei einer
 * Sitzung unter zehn Minuten sieht ihn niemand.
 *
 * DER GRUND IST PFLICHT — das Backend verlangt ihn (`@IsNotEmpty` in
 * `StornoDto`) und schreibt ihn auf die STORNORECHNUNG. Ein Storno ohne Grund
 * wäre in einem Jahr nicht mehr erklärbar.
 */
export function InvoiceCancelDialog({
  open,
  invoice,
  totpPossible,
  onClose,
  onCancelled,
}: {
  open: boolean;
  invoice: Invoice;
  /** Ohne Authenticator-App gibt es im Nachweis-Dialog nur den Passwortweg. */
  totpPossible: boolean;
  onClose: () => void;
  onCancelled: (result: { original: Invoice; cancellation: Invoice }) => void;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const evidenceState = useSecondFactorEvidence();
  const { close: evidenceClose } = evidenceState;

  useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
      evidenceClose();
    }
  }, [open, evidenceClose]);

  /** Erst ohne Nachweis; erst wenn der Server ihn verlangt, danach fragen. */
  async function cancel(evidence?: SecondFactorEvidence) {
    setLoading(true);
    setError(null);
    try {
      const result = await cancelInvoice(
        invoice.id,
        reason.trim(),
        evidence,
      );
      evidenceClose();
      onCancelled(result);
    } catch (f) {
      if (evidenceState.handle(f, evidence)) return;
      setError(errorText(f, t('components.invoiceCancelDialog.text')));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Dialog
        open={open}
        title={t('components.invoiceCancelDialog.title')}
        size="sm"
        onClose={() => {
          if (!loading) onClose();
        }}
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={loading}>
              {t('components.invoiceCancelDialog.button')}</Button>
            <Button
              form="storno-formular"
              type="submit"
              variant="danger"
              loading={loading}
              disabled={reason.trim().length === 0}
            >
              {t('components.invoiceCancelDialog.button2')}</Button>
          </>
        }
      >
        <form
          id="storno-formular"
          onSubmit={(ev) => {
            ev.preventDefault();
            void cancel();
          }}
          noValidate
        >
          <p className="mb-3 text-sm text-leise">
            {t('components.invoiceCancelDialog.text2')}{invoice.invoiceNumber}
          </p>

          <div className="mb-3">
            <p className="mb-1.5 text-sm font-semibold text-text">
              {t('components.invoiceCancelDialog.text3')}</p>
            <ul className="space-y-1 text-sm text-text">
              <li>
                {t('components.invoiceCancelDialog.item')}</li>
              <li>
                {t('components.invoiceCancelDialog.item2')}</li>
              <li>
                {t('components.invoiceCancelDialog.item3')}</li>
            </ul>
          </div>
          <div>
            <p className="mb-1.5 text-sm font-semibold text-text">
              {t('components.invoiceCancelDialog.text4')}</p>
            <ul className="space-y-1 text-sm text-text">
              <li>
                {t('components.invoiceCancelDialog.item4')}</li>
            </ul>
          </div>

          <div className="mt-4 text-left">
            <label
              htmlFor="storno-grund"
              className="mb-1 block text-sm font-medium text-text"
            >
              {t('components.invoiceCancelDialog.label')}</label>
            <textarea
              id="storno-grund"
              rows={3}
              value={reason}
              disabled={loading}
              onChange={(ev) => setReason(ev.target.value)}
              maxLength={300}
              placeholder={t('components.invoiceCancelDialog.placeholder')}
              className="w-full rounded-lg border border-rahmen bg-flaeche px-3 py-2 text-sm text-text placeholder:text-leise focus:border-primaer focus:outline-none disabled:opacity-70"
            />
            <p className="mt-1 text-sm text-leise">
              {t('components.invoiceCancelDialog.text5')}</p>
          </div>

          {error && (
            <p role="alert" className="mt-2 text-sm text-gefahr">
              {error}
            </p>
          )}
        </form>
      </Dialog>

      {/* NACH dem Storno-Dialog im Baum: Beide Overlays tragen `z-50`, es
        entscheidet die Reihenfolge im DOM. Andersherum läge die Fußleiste des
        Storno-Dialogs über dem Passwortfeld — bei 375 × 700 px der Fehler, der
        in dieser Anwendung schon zweimal auftrat. Gemessen, nicht angenommen. */}
      <SecondFactorEvidenceDialog
        open={evidenceState.open}
        title={t('components.invoiceCancelDialog.title')}
        declaration={t('components.invoiceCancelDialog.declaration')}
        totpPossible={totpPossible}
        loading={loading}
        error={evidenceState.error}
        onCancel={evidenceClose}
        onConfirm={(evidence) => void cancel(evidence)}
      />
    </>
  );
}
