import { useEffect, useState } from 'react';
import { Dialog, InputField, Button } from '@saas-instant/ui';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';
import { ApiError, errorText } from '../lib/api-client';
import {
  deleteContactData,
  type DeleteResult,
  type Company,
  type SecondFactorEvidence,
} from '../lib/api';
import { useT } from '../i18n';

/**
 * Löschung der Kontaktdaten — der einzige Weg, personenbezogene Daten wieder
 * loszuwerden, und der Vorgang, auf den der Dashboard-Vorschlag nach 24
 * Monaten hinausläuft. Ohne ihn wäre der Vorschlag eine Zusage, die niemand
 * einlösen kann.
 *
 * DREI SCHUTZSTUFEN, alle absichtlich:
 * 1. Der Name der Organisation muss abgetippt werden. Der Vorgang ist
 *    unumkehrbar; ein Fehlgriff in der Liste soll dafür nicht genügen.
 * 2. Der zweite Faktor. Mit einem erbeuteten Cookie ließe sich sonst der
 *    Kundenbestand entwerten.
 * 3. Der Dialog sagt VORHER, was verschwindet und was bleibt. Eine Löschung,
 *    deren Umfang man erst hinterher sieht, ist keine Einwilligung.
 *
 * Der Server LÖSCHT den Datensatz nicht, er anonymisiert ihn: Notizen hängen
 * mit `Restrict` daran, und der Statusverlauf ist Nachweis. Genau das steht
 * unten auch so da — die Oberfläche darf hier nichts versprechen, was das
 * Backend nicht tut.
 */
export function ContactDataDeleteDialog({
  open,
  company,
  totpPossible,
  onClose,
  onDeleted,
}: {
  open: boolean;
  company: Company;
  totpPossible: boolean;
  onClose: () => void;
  onDeleted: (result: DeleteResult) => void;
}) {
  const t = useT();
  const [confirmation, setConfirmation] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [dialogError, setDialogError] = useState<string>();

  useEffect(() => {
    if (open) {
      setConfirmation('');
      setError(null);
      setEvidenceOpen(false);
      setDialogError(undefined);
    }
  }, [open]);

  const matches = confirmation.trim() === company.name.trim();

  async function deleteIt(evidence?: SecondFactorEvidence) {
    setLoading(true);
    setError(null);
    try {
      const result = await deleteContactData(
        company.id,
        confirmation.trim(),
        evidence,
      );
      setEvidenceOpen(false);
      onDeleted(result);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        if (evidence) {
          setDialogError(
            evidence.totpCode !== undefined
              ? t('components.contactDataDeleteDialog.text')
              : t('components.contactDataDeleteDialog.text2'),
          );
        } else {
          setDialogError(undefined);
          setEvidenceOpen(true);
        }
        return;
      }
      setError(errorText(e, t('components.contactDataDeleteDialog.text3')));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Dialog
        open={open}
        title={t('components.contactDataDeleteDialog.title')}
        size="lg"
        onClose={() => {
          if (!loading) onClose();
        }}
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={loading}>
              {t('components.contactDataDeleteDialog.button')}</Button>
            <Button
              form="loeschen-formular"
              type="submit"
              variant="danger"
              loading={loading}
              disabled={!matches}
            >
              {t('components.contactDataDeleteDialog.button2')}</Button>
          </>
        }
      >
        {/* Eigene Kennung: `kontaktdaten-loeschen` ist schon die Sprungmarke
            der Karte auf der Detailseite. Zwei Elemente mit derselben id
            lassen `button.form` ins Leere laufen — der Absende-Knopf tat dann
            gar nichts, ohne Fehlermeldung. */}
        <form
          id="loeschen-formular"
          onSubmit={(ev) => {
            ev.preventDefault();
            void deleteIt();
          }}
          noValidate
        >
          <p className="mb-4 text-sm text-text">
            {t('components.contactDataDeleteDialog.text4')}</p>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-rahmen bg-flaeche-2 p-4">
              <h3 className="mb-2 text-sm font-semibold text-text">
                {t('components.contactDataDeleteDialog.heading')}</h3>
              <ul className="list-inside list-disc text-sm text-leise">
                <li>{t('components.contactDataDeleteDialog.item')}</li>
                <li>{t('components.contactDataDeleteDialog.item2')}</li>
                <li>{t('components.contactDataDeleteDialog.item3')}</li>
                <li>{t('components.contactDataDeleteDialog.item4')}</li>
                <li>
                  <span className="font-medium text-text">
                    {t('components.contactDataDeleteDialog.label')}</span>{' '}
                  {t('components.contactDataDeleteDialog.item5')}</li>
                <li>
                  {t('components.contactDataDeleteDialog.item6')}</li>
                <li>
                  {t('components.contactDataDeleteDialog.item7')}</li>
              </ul>
            </div>

            <div className="rounded-lg border border-rahmen bg-flaeche-2 p-4">
              <h3 className="mb-2 text-sm font-semibold text-text">
                {t('components.contactDataDeleteDialog.heading2')}</h3>
              <ul className="list-inside list-disc text-sm text-leise">
                <li>
                  {t('components.contactDataDeleteDialog.item8')}</li>
                <li>{t('components.contactDataDeleteDialog.item9')}</li>
                <li>{t('components.contactDataDeleteDialog.item10')}</li>
                <li>{t('components.contactDataDeleteDialog.item11')}</li>
                <li>{t('components.contactDataDeleteDialog.item12')}</li>
              </ul>
            </div>
          </div>

          <p className="mt-4 text-sm text-leise">
            {t('components.contactDataDeleteDialog.text5')}</p>

          <div className="mt-4">
            <InputField
              label={t('components.contactDataDeleteDialog.label2')}
              name="loesch-bestaetigung"
              autoComplete="off"
              value={confirmation}
              onChange={(ev) => setConfirmation(ev.target.value)}
              helperText={company.name}
              error={
                confirmation.trim() !== '' && !matches
                  ? t('components.contactDataDeleteDialog.error')
                  : undefined
              }
            />
          </div>

          {error && (
            <p role="alert" className="mt-2 text-sm text-gefahr">
              {error}
            </p>
          )}
        </form>
      </Dialog>

      <SecondFactorEvidenceDialog
        open={evidenceOpen}
        title={t('components.contactDataDeleteDialog.title')}
        declaration={t('components.contactDataDeleteDialog.declaration')}
        totpPossible={totpPossible}
        loading={loading}
        error={dialogError}
        onCancel={() => {
          setEvidenceOpen(false);
          setDialogError(undefined);
        }}
        onConfirm={(evidence) => void deleteIt(evidence)}
      />
    </>
  );
}
