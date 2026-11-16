import { useEffect, useState } from 'react';
import { Check, ShieldCheck, X } from 'lucide-react';
import { Dialog, InputField, Button } from '@saas-instant/ui';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';
import { ApiError, errorText } from '../lib/api-client';
import { useSecondFactorEvidence } from '../lib/second-factor';
import {
  arrangeBroadcast,
  type EnqueueResult,
  type Template,
  type SecondFactorEvidence,
} from '../lib/api';
import { useT } from '../i18n';

/**
 * Das Wort, das getippt werden muss.
 *
 * ES WIRD NICHT AN DEN SERVER GESCHICKT, und das ist kein Versehen:
 * `RundmailVersandDto` kennt nur die beiden Nachweisfelder, und die globale
 * `ValidationPipe` läuft mit `forbidNonWhitelisted` — ein zusätzliches Feld
 * ergäbe eine 400. Anders als beim Festschreiben einer Rechnung, wo der Server
 * die Bestätigung selbst prüft, ist dieses Wort also reiner Schutz vor dem
 * Fehlgriff im Browser.
 *
 * Es bleibt trotzdem, weil es etwas anderes leistet als der zweite Faktor: Das
 * Wort schützt gegen den versehentlichen Klick, der Faktor gegen die fremde
 * Hand. Die serverseitige Garantie ist und bleibt allein der `ZweitfaktorGuard`.
 */
export const SEND_CONFIRMATION = 'versenden';

/** Liest `detail.platzhalter` aus einem `offene_platzhalter`-Fehler. */
function openPlaceholdersFrom(error: unknown): string[] {
  if (!(error instanceof ApiError)) return [];
  if (error.error.code !== 'open_placeholders') return [];
  const detail = error.error.detail;
  if (typeof detail !== 'object' || detail === null) return [];
  const list = (detail as Record<string, unknown>)['placeholders'];
  return Array.isArray(list)
    ? list.filter((e): e is string => typeof e === 'string')
    : [];
}

function Row({ yes, children }: { yes: boolean; children: string }) {
  const Icon = yes ? Check : X;
  return (
    <li className="flex items-start gap-2">
      <Icon
        className={`mt-0.5 h-4 w-4 shrink-0 ${yes ? 'text-beschluss-text' : 'text-leise'}`}
        aria-hidden="true"
      />
      <span className="min-w-0 text-sm text-text">{children}</span>
    </li>
  );
}

/**
 * ===========================================================================
 * DER UNUMKEHRBARE SCHRITT — dasselbe Muster wie beim Festschreiben, härter
 * ===========================================================================
 *
 * Eine verschickte Rundmail holt niemand zurück. Es gibt keinen Storno, keine
 * Korrekturbuchung und keinen zweiten Beleg, der den ersten aufhebt — anders
 * als bei einer Rechnung. Der Schaden ist der Ruf der Domäne, und der trägt
 * zugleich die Zustellbarkeit der Rechnungen.
 *
 * DER DIALOG TRENNT DESHALB „DAS PASSIERT" VON „DAS PASSIERT NICHT". Eine
 * Warnung, die nur sagt „bist du sicher?", beantwortet die einzige Frage
 * nicht, die man an dieser Stelle hat: Was genau löst dieser Knopf aus, und
 * was löst er ausdrücklich NICHT aus. Beides steht als Liste da, weil sich in
 * einem Fliesstext genau die Zeile überlesen lässt, auf die es ankommt.
 *
 * DER ZWEITE FAKTOR IST DIE ECHTE SICHERUNG. Der Server verlangt ihn
 * (`RundmailVersandController` hängt am `ZweitfaktorGuard`); der Dialog geht
 * erst auf, wenn der Server ihn tatsächlich einfordert — bei einer Sitzung
 * unter zehn Minuten sieht ihn niemand.
 *
 * DER NACHWEIS-DIALOG STEHT IM BAUM NACH DIESEM, nicht darin: Beide Overlays
 * tragen `z-50`, entscheidend ist die Reihenfolge im DOM. Stünde er davor,
 * läge dieser Dialog darüber und verdeckte das Passwortfeld — der Fehler, der
 * bei 375 × 700 px schon mehrfach aufgetreten ist.
 */
export function BroadcastSendDialog({
  open,
  template,
  recipientCount,
  totpPossible,
  onClose,
  onEnqueued,
}: {
  open: boolean;
  template: Template;
  /** Die Vorhersage aus der Empfängerauswahl, oder `null`, wenn unbekannt. */
  recipientCount: number | null;
  totpPossible: boolean;
  onClose: () => void;
  onEnqueued: (result: EnqueueResult) => void;
}) {
  const t = useT();
  const [confirmation, setConfirmation] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openPlaceholders, setOpenPlaceholders] = useState<string[]>([]);
  const evidenceState = useSecondFactorEvidence();
  const { close: evidenceClose } = evidenceState;

  useEffect(() => {
    if (!open) return;
    setConfirmation('');
    setError(null);
    setOpenPlaceholders([]);
    evidenceClose();
    // In der Liste steht die STABILE Rückruffunktion, nicht die ganze Lage —
    // sonst machte der Effekt den Nachweis-Dialog sofort wieder zu.
  }, [open, evidenceClose]);

  const matches = confirmation.trim() === SEND_CONFIRMATION;

  async function enqueue(evidence?: SecondFactorEvidence) {
    setLoading(true);
    setError(null);
    setOpenPlaceholders([]);
    try {
      const result = await arrangeBroadcast(template.id, evidence);
      evidenceState.close();
      onEnqueued(result);
    } catch (f) {
      if (evidenceState.handle(f, evidence)) return;
      // Der Dialog bleibt offen: Bei offenen Platzhaltern ist die Liste
      // darunter genau das, was man jetzt braucht.
      setOpenPlaceholders(openPlaceholdersFrom(f));
      setError(errorText(f, t('components.broadcastSendDialog.text')));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Dialog
        open={open}
        title={t('components.broadcastSendDialog.title')}
        size="lg"
        onClose={() => {
          if (!loading) onClose();
        }}
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={loading}>
              {t('components.broadcastSendDialog.button')}</Button>
            <Button
              form="rundmail-versand-formular"
              type="submit"
              variant="danger"
              loading={loading}
              disabled={!matches}
            >
              {t('components.broadcastSendDialog.button2')}</Button>
          </>
        }
      >
        <form
          id="rundmail-versand-formular"
          onSubmit={(ev) => {
            ev.preventDefault();
            void enqueue();
          }}
          noValidate
        >
          <p className="mb-3 flex items-start gap-2 text-sm text-beschluss-text">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {t('components.broadcastSendDialog.consentNotice')}
          </p>

          <div className="mb-4 rounded-lg border-2 border-primaer bg-primaer-soft p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-primaer-softtext">
              {t('components.broadcastSendDialog.text2')}</p>
            <dl className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="text-sm text-leise">{t('components.broadcastSendDialog.text3')}</dt>
                <dd className="break-words text-sm font-medium text-text">
                  {template.name}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-sm text-leise">{t('components.broadcastSendDialog.text4')}</dt>
                <dd className="break-words text-sm font-medium text-text">
                  {template.subject}
                </dd>
              </div>
              <div className="min-w-0 sm:col-span-2">
                <dt className="text-sm text-leise">
                  {t('components.broadcastSendDialog.text5')}</dt>
                <dd className="ziffern-tabellarisch text-sm font-medium text-text">
                  {recipientCount === null
                    ? t('components.broadcastSendDialog.dd')
                    : `${recipientCount}`}
                </dd>
                <dd className="text-sm text-leise">
                  {t('components.broadcastSendDialog.text6')}</dd>
              </div>
            </dl>
          </div>

          <p className="text-sm font-semibold text-text">{t('components.broadcastSendDialog.text7')}</p>
          <ul className="mt-2 space-y-1.5">
            <Row yes>
              {t('components.broadcastSendDialog.text8')}</Row>
            <Row yes>
              {t('components.broadcastSendDialog.text9')}</Row>
            <Row yes>
              {t('components.broadcastSendDialog.text10')}</Row>
            <Row yes>
              {t('components.broadcastSendDialog.text11')}</Row>
          </ul>

          <p className="mt-4 text-sm font-semibold text-text">
            {t('components.broadcastSendDialog.text12')}</p>
          <ul className="mt-2 space-y-1.5">
            <Row yes={false}>
              {t('components.broadcastSendDialog.text13')}</Row>
            <Row yes={false}>
              {t('components.broadcastSendDialog.text14')}</Row>
            <Row yes={false}>
              {t('components.broadcastSendDialog.text15')}</Row>
            <Row yes={false}>
              {t('components.broadcastSendDialog.text16')}</Row>
            <Row yes={false}>
              {t('components.broadcastSendDialog.text17')}</Row>
          </ul>

          <div className="mt-4">
            <InputField
              id="versand-bestaetigung"
              name="versand-bestaetigung"
              label={t('components.broadcastSendDialog.label', { SEND_CONFIRMATION: SEND_CONFIRMATION })}
              autoComplete="off"
              value={confirmation}
              onChange={(ev) => setConfirmation(ev.target.value)}
              disabled={loading}
              error={
                confirmation.trim() !== '' && !matches
                  ? t('components.broadcastSendDialog.error')
                  : undefined
              }
            />
          </div>

          {error && (
            <div role="alert">
              <p className="text-sm text-gefahr">{error}</p>
              {openPlaceholders.length > 0 && (
                <>
                  <ul className="mt-2 list-inside list-disc text-sm text-text">
                    {openPlaceholders.map((name) => (
                      <li key={name} className="font-mono text-xs">
                        {`{{${name}}}`}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-sm text-leise">
                    {t('components.broadcastSendDialog.text18')}</p>
                </>
              )}
            </div>
          )}
        </form>
      </Dialog>

      <SecondFactorEvidenceDialog
        open={evidenceState.open}
        title={t('components.broadcastSendDialog.title')}
        declaration={t('components.broadcastSendDialog.declaration')}
        totpPossible={totpPossible}
        loading={loading}
        error={evidenceState.error}
        onCancel={evidenceState.close}
        onConfirm={(evidence) => void enqueue(evidence)}
      />
    </>
  );
}
