import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Dialog, InputField, Button } from '@saas-instant/ui';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';
import { ApiError, errorText } from '../lib/api-client';
import { TEXT_BUTTON } from '../lib/styles';
import { useSecondFactorEvidence } from '../lib/second-factor';
import {
  finalizeInvoice,
  FINALIZE_CONFIRMATION,
  type Company,
  type Invoice,
  type SecondFactorEvidence,
} from '../lib/api';
import { formatAmount } from '../utils/amount';
import { formatDate } from '../utils/date';
import { recipientPreview } from '../utils/recipient';
import { t, useT } from '../i18n';

/**
 * Liest `detail.fehlendeAngaben` aus einem `rechnung_unvollstaendig`-Fehler.
 *
 * Der Server zählt dort die Pflichtangaben nach § 14 UStG und § 125a HGB auf,
 * die AM AUSSTELLER fehlen. Ohne diese Liste stünde nur „Der Rechnung fehlen
 * Pflichtangaben" da — wahr, aber unbrauchbar.
 */
function missingDetailsFrom(error: unknown): string[] {
  if (!(error instanceof ApiError)) return [];
  if (error.error.code !== 'invoice_incomplete') return [];
  const detail = error.error.detail;
  if (typeof detail !== 'object' || detail === null) return [];
  const list = (detail as Record<string, unknown>)['missingDetails'];
  return Array.isArray(list)
    ? list.filter((e): e is string => typeof e === 'string')
    : [];
}

/**
 * Wo die fehlende Angabe gepflegt wird — abgeleitet aus ihrem Wortlaut.
 *
 * `fehlendePflichtangaben` (`rechnung.schnappschuss.ts`) prüft BEIDE Seiten
 * der Rechnung. Bis zum 2026-08-31 zeigte dieser Dialog dazu immer denselben
 * Satz: „Diese Angaben fehlen am Aussteller … über die Server-Konfiguration
 * gepflegt." Bei „Vollständige Anschrift der Rechnungsempfängerin" war das
 * schlicht falsch — die Angabe steht an der ORGANISATION und ist zwei Klicks
 * entfernt. Die Nutzerin wurde aktiv zur falschen Stelle geschickt ([K3]).
 *
 * Sortiert wird am Wortlaut, nicht an einer Liste von Zeichenketten: Der
 * Server bildet die Bezeichnungen nach demselben Muster, und eine Liste
 * müsste jemand pflegen, wenn dort eine Angabe dazukommt. Was nirgends passt,
 * gilt als Ausstellerangabe — das ist der grosse Rest (§ 125a HGB,
 * USt-IdNr., Bankverbindung) und die sichere Annahme.
 */
type Responsibility = 'company' | 'invoice' | 'issuer';

export function responsibleFor(info: string): Responsibility {
  if (info.includes(t('components.invoiceFinalizeDialog.text'))) return 'company';
  if (info.includes(t('components.invoiceFinalizeDialog.text2'))) return 'invoice';
  return 'issuer';
}

/**
 * DER UNUMKEHRBARE SCHRITT.
 *
 * Nach dem Festschreiben gibt es keinen Weg zurück außer einer
 * Stornorechnung — und die bleibt dauerhaft sichtbar. Der Dialog ist deshalb
 * so gebaut, dass man nicht versehentlich hineinstolpert und zugleich nicht
 * aus Gewohnheit hindurchklickt:
 *
 * 1. VORSCHAU STATT WARNUNG. Oben stehen genau die drei Angaben, bei denen
 *    man sich vertippt und die den häufigsten Stornogrund ausmachen —
 *    Leistungszeitraum, Posten (Stufe/Betrag) und Empfängeranschrift —,
 *    optisch abgesetzt vom Rest. Der erste Storno-Fall ist nicht der
 *    Kundenwunsch, sondern der eigene Tippfehler.
 * 2. DIE ANSCHRIFT IST EINE VORSCHAU, kein Schnappschuss: Der entsteht erst
 *    beim Festschreiben. Genau das ist ihr Zweck — zeigen, was gleich
 *    hineinkopiert wird, solange sich durch Abbrechen und Korrigieren der
 *    Organisationsdaten noch etwas daran ändern lässt.
 * 3. EIN GETIPPTES WORT **UND** DER ZWEITE FAKTOR.
 *
 *    Hier stand einmal „ein getipptes Wort STATT eines zweiten Faktors", mit
 *    der Begründung, das Festschreiben hinterlasse ja ein Dokument. Das war
 *    falsch: Ein getippter Text beweist, dass jemand es ernst meint; er
 *    beweist nicht, WER am Gerät sitzt. Mit einem eine Stunde alten
 *    Sitzungs-Cookie ließen sich Rechnungsnummern am Fließband verbrennen.
 *
 *    Beides bleibt, weil beides etwas anderes leistet: das Wort gegen den
 *    Fehlgriff, der Faktor gegen die fremde Hand. Der Nachweis-Dialog geht
 *    nur auf, wenn der Server ihn verlangt — bei einer Sitzung unter zehn
 *    Minuten sieht ihn niemand.
 */
export function InvoiceFinalizeDialog({
  open,
  invoice,
  company,
  totpPossible,
  onClose,
  onFinalized,
}: {
  open: boolean;
  invoice: Invoice;
  company: Company;
  /** Ohne Authenticator-App gibt es im Nachweis-Dialog nur den Passwortweg. */
  totpPossible: boolean;
  onClose: () => void;
  onFinalized: (invoice: Invoice) => void;
}) {
  const t = useT();
  const [confirmation, setConfirmation] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missingDetails, setMissingDetails] = useState<string[]>([]);
  const evidenceState = useSecondFactorEvidence();
  const { close: evidenceClose } = evidenceState;

  useEffect(() => {
    if (open) {
      setConfirmation('');
      setError(null);
      setMissingDetails([]);
      evidenceClose();
    }
    // In der Liste steht die STABILE Rückruffunktion, nicht die ganze Lage:
    // Die Lage ändert sich mit jedem Zustand des Nachweis-Dialogs, und der
    // Effekt würde den Dialog dann sofort wieder zumachen.
  }, [open, evidenceClose]);

  const recipient = recipientPreview(company);
  const matches = confirmation.trim() === FINALIZE_CONFIRMATION;

  // Reihenfolge fest, nicht nach Eingang: zuerst, was zwei Klicks entfernt
  // selbst zu beheben ist, zuletzt das, wofür jemand an den Server muss.
  const groups = (['company', 'invoice', 'issuer'] as const)
    .map((kind) => ({
      kind,
      details: missingDetails.filter((a) => responsibleFor(a) === kind),
    }))
    .filter((g) => g.details.length > 0);

  /**
   * Erst OHNE Nachweis rufen; erst wenn der Server ihn verlangt, den Dialog
   * aufklappen und mit Nachweis wiederholen.
   */
  async function finalize(evidence?: SecondFactorEvidence) {
    setLoading(true);
    setError(null);
    setMissingDetails([]);
    try {
      const fixed = await finalizeInvoice(invoice.id, evidence);
      evidenceState.close();
      onFinalized(fixed);
    } catch (f) {
      if (evidenceState.handle(f, evidence)) return;
      // Der Dialog bleibt offen: Die fehlenden Angaben stehen am Aussteller,
      // nicht an dieser Rechnung — sie zu schließen hieße, die Liste
      // wegzuwerfen, die man gerade braucht.
      setMissingDetails(missingDetailsFrom(f));
      setError(
        errorText(f, t('components.invoiceFinalizeDialog.text3')),
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Dialog
        open={open}
        title={t('components.invoiceFinalizeDialog.title')}
        size="lg"
        onClose={() => {
          if (!loading) onClose();
        }}
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={loading}>
              {t('components.invoiceFinalizeDialog.button')}</Button>
            <Button
              form="festschreiben-formular"
              type="submit"
              variant="danger"
              loading={loading}
              disabled={!matches}
            >
              {t('components.invoiceFinalizeDialog.button2')}</Button>
          </>
        }
      >
        <form
          id="festschreiben-formular"
          onSubmit={(ev) => {
            ev.preventDefault();
            void finalize();
          }}
          noValidate
        >
          <div className="mb-4 rounded-lg border-2 border-primaer bg-primaer-soft p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-primaer-softtext">
              {t('components.invoiceFinalizeDialog.text4')}</p>
            <dl className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="min-w-0">
                <dt className="text-sm text-leise">{t('components.invoiceFinalizeDialog.text5')}</dt>
                <dd className="ziffern-tabellarisch text-sm font-medium text-text">
                  {formatDate(invoice.servicePeriodFrom)} –{' '}
                  {formatDate(invoice.servicePeriodUntil)}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-sm text-leise">{t('components.invoiceFinalizeDialog.text6')}</dt>
                <dd className="break-words text-sm font-medium text-text">
                  {invoice.lines.map((p) => p.label).join(', ')}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-sm text-leise">{t('components.invoiceFinalizeDialog.text7')}</dt>
                <dd className="whitespace-pre-line break-words text-sm font-medium text-text">
                  {recipient.name}
                  {recipient.address !== '' && `\n${recipient.address}`}
                </dd>
              </div>
            </dl>
          </div>

          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-leise">{t('components.invoiceFinalizeDialog.text8')}</dt>
              <dd className="ziffern-tabellarisch text-sm text-text">
                {formatDate(invoice.invoiceDate)}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-leise">{t('components.invoiceFinalizeDialog.text9')}</dt>
              <dd className="ziffern-tabellarisch text-sm text-text">
                {formatDate(invoice.dueDate)}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-leise">{t('components.invoiceFinalizeDialog.text10')}</dt>
              <dd className="ziffern-tabellarisch text-sm text-text">
                {formatAmount(invoice.sumNet)}
              </dd>
            </div>
            {/* [W2] Die Steuersumme stand hier nicht, obwohl die Spezifikation
                alle drei verlangt — und obwohl sie in der Vorschau vor einem
                unumkehrbaren Schritt genau die Zahl ist, bei der ein falscher
                Steuersatz auffällt. */}
            <div>
              <dt className="text-sm text-leise">{t('components.invoiceFinalizeDialog.text11')}</dt>
              <dd className="ziffern-tabellarisch text-sm text-text">
                {formatAmount(invoice.sumTax)}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-leise">{t('components.invoiceFinalizeDialog.text12')}</dt>
              <dd className="ziffern-tabellarisch text-sm font-semibold text-text">
                {formatAmount(invoice.sumGross)}
              </dd>
            </div>
          </dl>

          <p className="mt-4 text-sm text-leise">
            {t('components.invoiceFinalizeDialog.text13')}</p>

          <div className="mt-4">
            <InputField
              id="festschreiben-bestaetigung"
              name="festschreiben-bestaetigung"
              label={t('components.invoiceFinalizeDialog.label', { FINALIZE_CONFIRMATION: FINALIZE_CONFIRMATION })}
              autoComplete="off"
              value={confirmation}
              onChange={(ev) => setConfirmation(ev.target.value)}
              disabled={loading}
              error={
                confirmation.trim() !== '' && !matches
                  ? t('components.invoiceFinalizeDialog.error')
                  : undefined
              }
            />
          </div>

          {error && (
            <div role="alert" className="mt-2">
              <p className="text-sm text-gefahr">{error}</p>
              {/* [K3] Je Zuständigkeit ein eigener Block — der Satz darunter
                  sagt, WO die Angabe gepflegt wird. Vorher stand unter jeder
                  Liste „am Aussteller, über die Server-Konfiguration", auch
                  wenn die Anschrift der Empfängerin fehlte. */}
              {groups.map(({ kind, details }) => (
                <div key={kind} className="mt-2">
                  <ul className="list-inside list-disc text-sm text-text">
                    {details.map((info) => (
                      <li key={info}>{info}</li>
                    ))}
                  </ul>
                  {kind === 'company' ? (
                    <p className="mt-1 text-sm text-leise">
                      {t('components.invoiceFinalizeDialog.text14')}{' '}
                      <Link
                        to={`/companies/${company.id}`}
                        className={TEXT_BUTTON}
                      >
                        {company.name} {t('components.invoiceFinalizeDialog.text15')}</Link>
                      {t('components.invoiceFinalizeDialog.text16')}</p>
                  ) : kind === 'invoice' ? (
                    <p className="mt-1 text-sm text-leise">
                      {t('components.invoiceFinalizeDialog.text17')}</p>
                  ) : (
                    <p className="mt-1 text-sm text-leise">
                      {t('components.invoiceFinalizeDialog.text18')}{' '}
                      <Link to="/settings?tab=company" className={TEXT_BUTTON}>
                        {t('components.invoiceFinalizeDialog.issuerLink')}</Link>.</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </form>
      </Dialog>

      {/* NACH dem Vorschau-Dialog im Baum, nicht darin: Beide Overlays tragen
        `z-50`, entscheidend ist damit die Reihenfolge im DOM. Stünde der
        Nachweis-Dialog davor, läge die Vorschau darüber und ihre Fußleiste
        verdeckte das Passwortfeld — genau der Fehler, der bei 375 × 700 px
        schon zweimal auftrat. Gemessen, nicht angenommen. */}
      <SecondFactorEvidenceDialog
        open={evidenceState.open}
        title={t('components.invoiceFinalizeDialog.title')}
        declaration={t('components.invoiceFinalizeDialog.declaration')}
        totpPossible={totpPossible}
        loading={loading}
        error={evidenceState.error}
        onCancel={evidenceState.close}
        onConfirm={(evidence) => void finalize(evidence)}
      />
    </>
  );
}
