import { useEffect, useState } from 'react';
import { today } from '@saas-instant/shared';
import { Dialog, DateField, InputField, Button } from '@saas-instant/ui';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';
import { ApiError, errorText } from '../lib/api-client';
import {
  notePayment,
  type Invoice,
  type SecondFactorEvidence,
} from '../lib/api';
import { centFromInput, formatAmount, formatAmountCent } from '../utils/amount';
import { cumulativePaidCent, type PaymentMode } from '../utils/payment';
import { useT } from '../i18n';

/**
 * Zahlung vermerken — HINTER DEM ZWEITEN FAKTOR.
 *
 * Der Unterschied zum Festschreiben ist kein Zufall und keine Doppelung: Wer
 * eine Rechnung festschreibt oder storniert, hinterlässt ein Dokument mit
 * Nummer, Systemnotiz und Audit-Eintrag. Wer den Zahlungsstand setzt,
 * hinterlässt keines — er löscht lautlos eine Forderung aus der Übersicht,
 * und die Dashboard-Aufgabe „überfällig" verschwindet gleich mit, weil sie
 * abgeleitet ist. Genau diese stille Wirkung ist der Maßstab für den zweiten
 * Faktor.
 *
 * Der Fluss ist derselbe wie bei den vertraulichen Vorgängen aus Etappe 2:
 * erst OHNE Nachweis rufen (bei einer Sitzung unter zehn Minuten lässt der
 * Server ihn weg), und erst bei `401` den Nachweis-Dialog aufklappen.
 *
 * DER SERVER NIMMT DEN KUMULIERTEN GESAMTSTAND, nicht die einzelne
 * Überweisung. Ein Modell mit Einzelbuchungen bräuchte einen Weg, eine falsch
 * erfasste Buchung zurückzunehmen — also einen Löschpfad an einem Beleg, den
 * es ausdrücklich nicht gibt. Der Dialog fragt trotzdem in der Sprache der
 * Überweisung („voll bezahlt“ / „Teilzahlung“) und rechnet vor dem Senden
 * auf den Gesamtstand um (`cumulativePaidCent`).
 */
export function PaymentRecordDialog({
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
  const todayDay = today();
  const [paymentDate, setPaymentDate] = useState(todayDay);
  const [mode, setMode] = useState<PaymentMode>('full');
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string>();
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [dialogError, setDialogError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setPaymentDate(today());
    // Vorauswahl ist „voll bezahlt“: Der häufigste Fall ist die vollständige
    // Zahlung. Erst „Teilzahlung“ öffnet das Betragsfeld.
    setMode('full');
    setAmount('');
    setError(null);
    setAmountError(undefined);
    setEvidenceOpen(false);
    setDialogError(undefined);
  }, [open, invoice.sumGrossCent]);

  // Was bereits erfasst ist, in Cent — die Teilzahlung wird darauf addiert.
  const alreadyPaidCent =
    invoice.paidAmount === null ? 0 : (centFromInput(invoice.paidAmount) ?? 0);

  async function record(evidence?: SecondFactorEvidence) {
    const cent = cumulativePaidCent(
      mode,
      invoice.sumGrossCent,
      alreadyPaidCent,
      amount,
    );
    if (cent === null) {
      setAmountError(
        t('components.paymentRecordDialog.text'),
      );
      return;
    }
    setAmountError(undefined);
    setLoading(true);
    setError(null);
    try {
      const updated = await notePayment(
        invoice.id,
        { paymentDate, paidAmountCent: cent },
        evidence,
      );
      setEvidenceOpen(false);
      onNoted(updated);
    } catch (f) {
      if (f instanceof ApiError && f.status === 401) {
        if (evidence) {
          setDialogError(
            evidence.totpCode !== undefined
              ? t('components.paymentRecordDialog.text2')
              : t('components.paymentRecordDialog.text3'),
          );
        } else {
          setDialogError(undefined);
          setEvidenceOpen(true);
        }
        return;
      }
      // Die Plausibilitätsmeldungen des Servers („Das Zahldatum liegt vor dem
      // Rechnungsdatum.") sind bereits für Menschen geschrieben — ein eigener
      // Wortlaut wäre hier eine schlechtere Auskunft.
      setError(errorText(f, t('components.paymentRecordDialog.text4')));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Dialog
        open={open}
        title={t('components.paymentRecordDialog.title')}
        size="sm"
        onClose={() => {
          if (!loading) onClose();
        }}
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={loading}>
              {t('components.paymentRecordDialog.button')}</Button>
            <Button
              form="zahlung-formular"
              type="submit"
              loading={loading}
              disabled={paymentDate === '' || (mode === 'partial' && amount.trim() === '')}
            >
              {t('components.paymentRecordDialog.button2')}</Button>
          </>
        }
      >
        <form
          id="zahlung-formular"
          onSubmit={(ev) => {
            ev.preventDefault();
            void record();
          }}
          noValidate
        >
          <p className="mb-4 text-sm text-leise">
            {t('components.paymentRecordDialog.text5')}{invoice.invoiceNumber} —{' '}
            <span className="ziffern-tabellarisch font-medium text-text">
              {formatAmount(invoice.sumGross)}
            </span>{' '}
            {t('components.paymentRecordDialog.text6')}</p>

          <DateField
            id="zahlung-zahldatum"
            label={t('components.paymentRecordDialog.label')}
            value={paymentDate}
            onChange={setPaymentDate}
            max={todayDay}
            required
            autoFocus
          />

          <fieldset className="mt-4" disabled={loading}>
            <legend className="mb-2 text-sm font-medium text-text">
              {t('components.paymentRecordDialog.legend')}
            </legend>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-text">
              <input
                type="radio"
                name="zahlung-art"
                className="size-4 accent-primaer"
                checked={mode === 'full'}
                onChange={() => {
                  setMode('full');
                  setAmountError(undefined);
                }}
              />
              <span>
                {t('components.paymentRecordDialog.full')}{' '}
                <span className="ziffern-tabellarisch">
                  ({formatAmount(invoice.sumGross)})
                </span>
              </span>
            </label>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-text">
              <input
                type="radio"
                name="zahlung-art"
                className="size-4 accent-primaer"
                checked={mode === 'partial'}
                onChange={() => setMode('partial')}
              />
              <span>{t('components.paymentRecordDialog.partial')}</span>
            </label>
          </fieldset>

          {mode === 'partial' && (
            <InputField
              id="zahlung-betrag"
              name="zahlung-betrag"
              label={t('components.paymentRecordDialog.label2')}
              type="number"
              step="0.01"
              inputMode="decimal"
              autoComplete="off"
              autoFocus
              value={amount}
              disabled={loading}
              onChange={(ev) => setAmount(ev.target.value)}
              helperText={`${t('components.paymentRecordDialog.paidSoFar')} ${formatAmountCent(alreadyPaidCent)} · ${t('components.paymentRecordDialog.open')} ${formatAmount(invoice.openAmount)}`}
              error={amountError}
            />
          )}

          {error && (
            <p role="alert" className="mt-2 text-sm text-gefahr">
              {error}
            </p>
          )}
        </form>
      </Dialog>

      <SecondFactorEvidenceDialog
        open={evidenceOpen}
        title={t('components.paymentRecordDialog.title2')}
        declaration={t('components.paymentRecordDialog.declaration')}
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
