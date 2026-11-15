import { useEffect, useState } from 'react';
import { Dialog, InputField, Button } from '@saas-instant/ui';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';
import { ApiError, errorText } from '../lib/api-client';
import {
  deleteCompany,
  type Company,
  type CompanyDeleteResult,
  type SecondFactorEvidence,
} from '../lib/api';
import { useT } from '../i18n';

/**
 * DIE ORGANISATION GANZ ENTFERNEN.
 *
 * Nicht zu verwechseln mit `KontaktdatenLoeschenDialog`: Dort bleibt der
 * Datensatz stehen und wird anonymisiert, weil Belege an ihm hängen. Hier ist
 * die Zeile hinterher wirklich weg — und genau deshalb geht es nur, solange
 * keine Belege da sind.
 *
 * WOFÜR ES IHN GIBT: Jede Anfrage über das Formular und jede Demo legt eine
 * Organisation an. Ohne diesen Weg sammelt sich jeder Probelauf für immer im
 * Register, und irgendwann unterscheidet niemand mehr die echten Kunden von
 * den verworfenen Versuchen.
 *
 * DIE PRÜFUNG LIEGT BEIM SERVER, nicht hier. Diese Seite weiß nicht sicher,
 * ob es eine Instanz oder eine Rechnung gibt — die Instanz-Karte lädt ihre
 * Daten selbst, und beides kann sich zwischen Laden und Klick ändern. Der
 * Knopf ist deshalb immer bedienbar, und was im Weg steht, sagt die Antwort:
 * Sie nennt ALLE Hindernisse auf einmal, nicht nur das erste.
 */
export function CompanyDeleteDialog({
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
  onDeleted: (result: CompanyDeleteResult) => void;
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
      const result = await deleteCompany(
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
              ? t('components.companyDeleteDialog.text')
              : t('components.companyDeleteDialog.text2'),
          );
        } else {
          setDialogError(undefined);
          setEvidenceOpen(true);
        }
        return;
      }
      // Der 409 kommt hier heraus. Seine Meldung IST die Erklärung — sie
      // zählt auf, was im Weg steht, und wird deshalb unverändert gezeigt.
      // Der Nachweisdialog muss dabei zu sein, sonst steht der Text hinter
      // ihm.
      setEvidenceOpen(false);
      setError(
        errorText(e, t('components.companyDeleteDialog.text3')),
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Dialog
        open={open}
        title={t('components.companyDeleteDialog.title')}
        size="lg"
        onClose={() => {
          if (!loading) onClose();
        }}
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={loading}>
              {t('components.companyDeleteDialog.button')}</Button>
            <Button
              form="organisation-loeschen-formular"
              type="submit"
              variant="danger"
              loading={loading}
              disabled={!matches}
            >
              {t('components.companyDeleteDialog.button2')}</Button>
          </>
        }
      >
        <form
          id="organisation-loeschen-formular"
          onSubmit={(ev) => {
            ev.preventDefault();
            void deleteIt();
          }}
          noValidate
        >
          <p className="mb-4 text-sm text-text">
            {t('components.companyDeleteDialog.text4')}</p>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-rahmen bg-flaeche-2 p-4">
              <h3 className="mb-2 text-sm font-semibold text-text">
                {t('components.companyDeleteDialog.heading')}</h3>
              <ul className="list-inside list-disc text-sm text-leise">
                <li>{t('components.companyDeleteDialog.item')}</li>
                <li>{t('components.companyDeleteDialog.item2')}</li>
                <li>{t('components.companyDeleteDialog.item3')}</li>
                <li>{t('components.companyDeleteDialog.item4')}</li>
                <li>
                  {t('components.companyDeleteDialog.item5')}<span className="text-leise"> {t('components.companyDeleteDialog.label')}</span>
                </li>
                <li>{t('components.companyDeleteDialog.item6')}</li>
              </ul>
            </div>

            <div className="rounded-lg border border-rahmen bg-flaeche-2 p-4">
              <h3 className="mb-2 text-sm font-semibold text-text">
                {t('components.companyDeleteDialog.heading2')}</h3>
              <ul className="list-inside list-disc text-sm text-leise">
                <li>
                  <span className="font-medium text-text">{t('components.companyDeleteDialog.label2')}</span> {t('components.companyDeleteDialog.item7')}</li>
                <li>
                  {t('components.companyDeleteDialog.item8')}</li>
              </ul>
            </div>
          </div>

          <p className="mt-4 text-sm text-leise">
            {t('components.companyDeleteDialog.text5')}</p>

          <div className="mt-4">
            <InputField
              label={t('components.companyDeleteDialog.label3')}
              name="organisation-loesch-bestaetigung"
              autoComplete="off"
              value={confirmation}
              onChange={(ev) => setConfirmation(ev.target.value)}
              helperText={company.name}
              error={
                confirmation.trim() !== '' && !matches
                  ? t('components.companyDeleteDialog.error')
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
        title={t('components.companyDeleteDialog.title')}
        declaration={t('components.companyDeleteDialog.declaration')}
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
