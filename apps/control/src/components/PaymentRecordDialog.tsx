import { useEffect, useState } from 'react';
import { today } from '@saas-instant/shared';
import { Dialog, DateField, InputField, Button } from '@saas-instant/ui';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';
import { errorText } from '../lib/api-client';
import { useSecondFactorEvidence } from '../lib/second-factor';
import {
  notePayment,
  type Invoice,
  type SecondFactorEvidence,
} from '../lib/api';
import {
  centAsFieldValue,
  centFromInput,
  formatAmount,
  formatAmountCent,
} from '../utils/amount';
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
 *
 * [M13] DRITTE OPTION „ZAHLUNGSSTAND BERICHTIGEN": Wer eine Zahlung falsch
 * erfasst hat, tippt den richtigen Gesamtstand (auch 0) und überschreibt
 * damit den alten — der Server hält die Berichtigung im Audit-Log fest. Der
 * Dialog sendet immer den bisher angezeigten Stand mit (`expectedPaidCent`):
 * Hat inzwischen jemand anderes etwas erfasst, antwortet der Server mit 409
 * statt es still zu überschreiben.
 */
export function PaymentRecordDialog({
  open,
  invoice,
  totpPossible,
  initialMode = 'full',
  onClose,
  onNoted,
}: {
  open: boolean;
  invoice: Invoice;
  totpPossible: boolean;
  /** Mit welcher Auswahl der Dialog aufgeht (`correct` aus dem Menü „Weitere“). */
  initialMode?: PaymentMode;
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
  const evidenceState = useSecondFactorEvidence();

  // Was bereits erfasst ist, in Cent — die Teilzahlung wird darauf addiert.
  const alreadyPaidCent =
    invoice.paidAmount === null ? 0 : (centFromInput(invoice.paidAmount) ?? 0);
  // Berichtigen gibt es nur, wo etwas erfasst ist.
  const canCorrect = alreadyPaidCent !== 0;

  useEffect(() => {
    if (!open) return;
    // Vorauswahl ist „voll bezahlt“: Der häufigste Fall ist die vollständige
    // Zahlung. Erst „Teilzahlung“ öffnet das Betragsfeld. Aus dem Menü
    // „Weitere“ kommt „berichtigen“, vorbelegt mit dem bisherigen Stand.
    const start: PaymentMode =
      initialMode === 'correct' && canCorrect ? 'correct' : 'full';
    setMode(start);
    setPaymentDate(
      start === 'correct' && invoice.paymentDate ? invoice.paymentDate : today(),
    );
    setAmount(start === 'correct' ? centAsFieldValue(alreadyPaidCent) : '');
    setError(null);
    setAmountError(undefined);
    evidenceState.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, invoice.sumGrossCent, initialMode]);

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
        {
          paymentDate,
          paidAmountCent: cent,
          expectedPaidCent: alreadyPaidCent,
        },
        evidence,
      );
      evidenceState.close();
      onNoted(updated);
    } catch (f) {
      if (evidenceState.handle(f, evidence)) return;
      evidenceState.close();
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
        title={
          mode === 'correct'
            ? t('components.paymentRecordDialog.correct')
            : t('components.paymentRecordDialog.title')
        }
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
              disabled={paymentDate === '' || (mode !== 'full' && amount.trim() === '')}
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
            {canCorrect && (
              <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-text">
                <input
                  type="radio"
                  name="zahlung-art"
                  className="size-4 accent-primaer"
                  checked={mode === 'correct'}
                  onChange={() => {
                    setMode('correct');
                    setAmount(centAsFieldValue(alreadyPaidCent));
                    setAmountError(undefined);
                  }}
                />
                <span>{t('components.paymentRecordDialog.correct')}</span>
              </label>
            )}
          </fieldset>

          {mode !== 'full' && (
            <InputField
              id="zahlung-betrag"
              name="zahlung-betrag"
              label={
                mode === 'correct'
                  ? t('components.paymentRecordDialog.label3')
                  : t('components.paymentRecordDialog.label2')
              }
              type="number"
              step="0.01"
              inputMode="decimal"
              autoComplete="off"
              autoFocus
              value={amount}
              disabled={loading}
              onChange={(ev) => setAmount(ev.target.value)}
              helperText={
                mode === 'correct'
                  ? t('components.paymentRecordDialog.correctHint', {
                      paid: formatAmountCent(alreadyPaidCent),
                    })
                  : `${t('components.paymentRecordDialog.paidSoFar')} ${formatAmountCent(alreadyPaidCent)} · ${t('components.paymentRecordDialog.open')} ${formatAmount(invoice.openAmount)}`
              }
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
        open={evidenceState.open}
        title={t('components.paymentRecordDialog.title2')}
        declaration={t('components.paymentRecordDialog.declaration')}
        totpPossible={totpPossible}
        loading={loading}
        error={evidenceState.error}
        onCancel={evidenceState.close}
        onConfirm={(evidence) => void record(evidence)}
      />
    </>
  );
}
