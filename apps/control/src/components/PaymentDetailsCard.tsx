import { useEffect, useState } from 'react';
import { Eye, EyeOff, Lock, Pencil } from 'lucide-react';
import { DateField, InputField, Card, Button, useToast } from '@saas-instant/ui';
import { Field } from './DetailBlock';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';
import { ApiError, errorText } from '../lib/api-client';
import {
  fetchPaymentDetails,
  setPaymentDetails,
  type PaymentDetails,
  type PaymentDetailsChange,
  type SecondFactorEvidence,
} from '../lib/api';
import { formatAmount } from '../utils/amount';
import { formatDate } from '../utils/date';
import { useT } from '../i18n';

/** Wofür gerade ein Nachweis verlangt wird — der Dialog ist derselbe. */
type Purpose = 'show' | 'save';

interface Draft {
  iban: string;
  sepaMandateReference: string;
  sepaMandateDate: string;
  customAmount: string;
}

function draftFrom(d: PaymentDetails): Draft {
  return {
    iban: d.iban ?? '',
    sepaMandateReference: d.sepaMandateReference ?? '',
    sepaMandateDate: d.sepaMandateDate ?? '',
    customAmount: d.customAmount ?? '',
  };
}

/**
 * Bankverbindung und SEPA-Mandat — hinter dem zweiten Faktor.
 *
 * WARUM DIESE KARTE ANDERS IST ALS DIE ÜBRIGEN: Die Detailansicht liefert die
 * Werte nicht mehr mit, nur noch `zahlungsdatenHinterlegt`. Vorher genügte ein
 * 25 Stunden altes Sitzungs-Cookie, um an einer gewöhnlichen Detailseite die
 * IBAN mitzulesen. Eine Bankverbindung ist kein Stammdatum, sie ist der
 * Zahlungsweg.
 *
 * Anzeigen UND Ändern gehen deshalb über eigene Endpunkte, beide als POST bzw.
 * PATCH — auch das Anzeigen, weil der Server den Nachweis aus dem Rumpf liest
 * und ein GET keinen hat. Auch das LESEN steht im Audit-Log: Bei einer
 * Bankverbindung ist der Zugriff selbst die Handlung, nach der später gefragt
 * wird.
 *
 * MUSTER WIE IN ETAPPE 1: erst ohne Nachweis versuchen, bei `401` nachfragen.
 * Wer gerade erst angemeldet ist (Sitzung unter zehn Minuten), sieht den
 * Dialog nie.
 *
 * DIE WERTE VERSCHWINDEN WIEDER. Sie stehen nach dem Anzeigen im Speicher der
 * Seite; deshalb gibt es „Ausblenden", und beim Verlassen der Organisation
 * fallen sie mit dem Zustand dieser Komponente weg. Bewusst KEIN Zeitschloss,
 * das von selbst zuklappt: Es träfe zuverlässig den Moment, in dem jemand
 * gerade eine IBAN abtippt, und der Gewinn wäre gering — wer den Bildschirm
 * unbeaufsichtigt lässt, hat die Seite ohnehin offen.
 */
export function PaymentDetailsCard({
  companyId,
  stored,
  totpPossible,
  onChanged,
}: {
  companyId: string;
  /** Aus der Detailansicht: ob überhaupt etwas hinterlegt ist. */
  stored: boolean;
  /** Ohne Authenticator-App gibt es nur den Passwortweg. */
  totpPossible: boolean;
  /** Nach dem Speichern: `zahlungsdatenHinterlegt` kann sich geändert haben. */
  onChanged: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [data, setData] = useState<PaymentDetails | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [purpose, setPurpose] = useState<Purpose | null>(null);
  const [dialogError, setDialogError] = useState<string>();

  // Wechselt die Organisation, gehören die alten Werte nicht mehr auf den
  // Schirm — auch nicht für einen Wimpernschlag.
  useEffect(() => {
    setData(null);
    setDraft(null);
    setError(null);
    setPurpose(null);
  }, [companyId]);

  /**
   * Ein `401` heißt: Nachweis nötig ODER Nachweis falsch. Unterschieden wird
   * daran, ob gerade einer mitgeschickt wurde.
   */
  function evidenceRequired(e: unknown, forValue: Purpose, evidence?: SecondFactorEvidence): boolean {
    if (!(e instanceof ApiError) || e.status !== 401) return false;
    if (evidence) {
      setDialogError(
        evidence.totpCode !== undefined
          ? t('components.paymentDetailsCard.text')
          : t('components.paymentDetailsCard.text2'),
      );
    } else {
      setDialogError(undefined);
      setPurpose(forValue);
    }
    return true;
  }

  async function show(evidence?: SecondFactorEvidence) {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchPaymentDetails(companyId, evidence));
      setPurpose(null);
    } catch (e) {
      if (evidenceRequired(e, 'show', evidence)) return;
      setError(errorText(e, t('components.paymentDetailsCard.text3')));
    } finally {
      setLoading(false);
    }
  }

  async function save(evidence?: SecondFactorEvidence) {
    if (!draft) return;
    const amount = draft.customAmount.trim();
    if (amount !== '' && !Number.isFinite(Number(amount))) {
      setError(t('components.paymentDetailsCard.text4'));
      return;
    }
    // Leere Felder werden weggelassen, nicht als "" geschickt: Der Server
    // prüft jedes mitgeschickte Feld.
    const change: PaymentDetailsChange = {
      ...(draft.iban.trim() !== '' ? { iban: draft.iban.trim() } : {}),
      ...(draft.sepaMandateReference.trim() !== ''
        ? { sepaMandateReference: draft.sepaMandateReference.trim() }
        : {}),
      ...(draft.sepaMandateDate !== ''
        ? { sepaMandateDate: draft.sepaMandateDate }
        : {}),
      ...(amount !== '' ? { customAmount: Number(amount) } : {}),
    };
    setLoading(true);
    setError(null);
    try {
      setData(await setPaymentDetails(companyId, change, evidence));
      setDraft(null);
      setPurpose(null);
      toast.show(t('components.paymentDetailsCard.text5'));
      onChanged();
    } catch (e) {
      if (evidenceRequired(e, 'save', evidence)) return;
      setError(errorText(e, t('components.paymentDetailsCard.text6')));
    } finally {
      setLoading(false);
    }
  }

  function hide() {
    setData(null);
    setDraft(null);
    setError(null);
  }

  return (
    <Card className="mt-6 p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-text">{t('components.paymentDetailsCard.heading')}</h2>
        {data && !draft && (
          <div className="flex flex-wrap gap-2">
            {/* Ausgeschrieben, nicht bloß „Bearbeiten": Im Verlauf derselben
                Seite steht an jeder eigenen Notiz ebenfalls ein „Bearbeiten".
                Zwei gleichnamige Knöpfe sind für Vorlesesoftware nicht
                unterscheidbar. */}
            <Button variant="secondary" onClick={() => setDraft(draftFrom(data))}>
              <Pencil className="h-4 w-4" aria-hidden="true" />
              {t('components.paymentDetailsCard.button')}</Button>
            <Button variant="ghost" onClick={hide}>
              <EyeOff className="h-4 w-4" aria-hidden="true" />
              {t('components.paymentDetailsCard.button2')}</Button>
          </div>
        )}
      </div>

      {data === null ? (
        <>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-flaeche-3 text-leise">
              <Lock className="h-4 w-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-sm text-text">
                {stored
                  ? t('components.paymentDetailsCard.text7')
                  : t('components.paymentDetailsCard.text8')}
              </p>
              <p className="mt-1 text-sm text-leise">
                {t('components.paymentDetailsCard.text9')}</p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button variant="secondary" loading={loading} onClick={() => void show()}>
              <Eye className="h-4 w-4" aria-hidden="true" />
              {t('components.paymentDetailsCard.button3')}</Button>
            {!stored && (
              <span className="self-center text-sm text-leise">
                {t('components.paymentDetailsCard.label')}</span>
            )}
          </div>
        </>
      ) : draft ? (
        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            void save();
          }}
          noValidate
        >
          <fieldset disabled={loading} className="min-w-0 border-0 p-0">
            <InputField
              label="IBAN"
              name="zd-iban"
              value={draft.iban}
              onChange={(ev) => setDraft({ ...draft, iban: ev.target.value })}
              helperText={t('components.paymentDetailsCard.helperText')}
            />
            <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
              <InputField
                label={t('components.paymentDetailsCard.label2')}
                name="zd-referenz"
                value={draft.sepaMandateReference}
                onChange={(ev) =>
                  setDraft({ ...draft, sepaMandateReference: ev.target.value })
                }
              />
              <DateField
                label={t('components.paymentDetailsCard.label3')}
                name="zd-datum"
                value={draft.sepaMandateDate}
                onChange={(value) => setDraft({ ...draft, sepaMandateDate: value })}
              />
            </div>
            <InputField
              label={t('components.paymentDetailsCard.label4')}
              name="zd-betrag"
              type="number"
              step="0.01"
              min="0"
              inputMode="decimal"
              value={draft.customAmount}
              onChange={(ev) =>
                setDraft({ ...draft, customAmount: ev.target.value })
              }
              helperText={t('components.paymentDetailsCard.helperText2')}
            />
          </fieldset>
          {error && (
            <p role="alert" className="mt-3 text-sm text-gefahr">
              {error}
            </p>
          )}
          <div className="-mx-6 -mb-6 mt-6 flex flex-wrap justify-end gap-3 rounded-b-xl border-t border-rahmen bg-flaeche-2 px-6 py-4">
            <Button
              variant="ghost"
              type="button"
              disabled={loading}
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
            >
              {t('components.paymentDetailsCard.button4')}</Button>
            <Button type="submit" loading={loading}>
              {t('components.paymentDetailsCard.button5')}</Button>
          </div>
        </form>
      ) : (
        <>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="IBAN" wide>
              {data.iban}
            </Field>
            <Field
              label={t('components.paymentDetailsCard.label5')}
              onAdd={() => setDraft(draftFrom(data))}
            >
              {data.sepaMandateReference}
            </Field>
            <Field
              label={t('components.paymentDetailsCard.label6')}
              onAdd={() => setDraft(draftFrom(data))}
            >
              {data.sepaMandateDate && (
                <span className="ziffern-tabellarisch">
                  {formatDate(data.sepaMandateDate)}
                </span>
              )}
            </Field>
            <Field
              label={t('components.paymentDetailsCard.label7')}
              wide
              onAdd={() => setDraft(draftFrom(data))}
            >
              {data.customAmount && formatAmount(data.customAmount)}
            </Field>
          </dl>
          {error && (
            <p role="alert" className="mt-3 text-sm text-gefahr">
              {error}
            </p>
          )}
        </>
      )}

      {data === null && error && (
        <p role="alert" className="mt-3 text-sm text-gefahr">
          {error}
        </p>
      )}

      <SecondFactorEvidenceDialog
        open={purpose !== null}
        title={
          purpose === 'save'
            ? t('components.paymentDetailsCard.title')
            : t('components.paymentDetailsCard.title2')
        }
        declaration={
          purpose === 'save'
            ? t('components.paymentDetailsCard.declaration')
            : t('components.paymentDetailsCard.declaration2')
        }
        totpPossible={totpPossible}
        loading={loading}
        error={dialogError}
        onCancel={() => {
          setPurpose(null);
          setDialogError(undefined);
        }}
        onConfirm={(evidence) => {
          if (purpose === 'save') void save(evidence);
          else void show(evidence);
        }}
      />
    </Card>
  );
}
