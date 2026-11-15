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
import { centAsFieldValue, centFromInput, formatAmount } from '../utils/amount';
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
 * DER BETRAG IST DER KUMULIERTE GESAMTSTAND, nicht die einzelne Überweisung.
 * Ein Modell mit Einzelbuchungen bräuchte einen Weg, eine falsch erfasste
 * Buchung zurückzunehmen — also einen Löschpfad an einem Beleg, den es
 * ausdrücklich nicht gibt.
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
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string>();
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [dialogError, setDialogError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setPaymentDate(today());
    // Vorbelegung ist der VOLLE Betrag: Der häufigste Fall ist die
    // vollständige Zahlung. Wer teilweise erfasst, überschreibt die Zahl.
    setAmount(centAsFieldValue(invoice.sumGrossCent));
    setError(null);
    setAmountError(undefined);
    setEvidenceOpen(false);
    setDialogError(undefined);
  }, [open, invoice.sumGrossCent]);

  async function record(evidence?: SecondFactorEvidence) {
    const cent = centFromInput(amount);
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
              disabled={paymentDate === '' || amount.trim() === ''}
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
            {t('components.paymentRecordDialog.text6')}{invoice.paidAmount !== null && (
              <>
                {' '}
                {t('components.paymentRecordDialog.text7')}{' '}
                <span className="ziffern-tabellarisch font-medium text-text">
                  {formatAmount(invoice.paidAmount)}
                </span>
                .
              </>
            )}
          </p>

          <DateField
            id="zahlung-zahldatum"
            label={t('components.paymentRecordDialog.label')}
            value={paymentDate}
            onChange={setPaymentDate}
            max={todayDay}
            required
          />

          <InputField
            id="zahlung-betrag"
            name="zahlung-betrag"
            label={t('components.paymentRecordDialog.label2')}
            type="number"
            step="0.01"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            disabled={loading}
            onChange={(ev) => setAmount(ev.target.value)}
            helperText={t('components.paymentRecordDialog.helperText')}
            error={amountError}
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
