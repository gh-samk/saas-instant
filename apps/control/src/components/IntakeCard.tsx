import { useCallback, useEffect, useState } from 'react';
import { Copy, Mail } from 'lucide-react';
import { Card, Button, Skeleton, useToast } from '@saas-instant/ui';
import { errorText } from '../lib/api-client';
import {
  fetchIntakeAccess,
  sendIntakeLink,
  showIntakeLink,
  type IntakeAccessState,
  type SecondFactorEvidence,
} from '../lib/api';
import { useSecondFactorEvidence } from '../lib/second-factor';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';
import { formatDate } from '../utils/date';
import { t, useT } from '../i18n';

interface Props {
  companyId: string;
  totpPossible: boolean;
}

/**
 * ===========================================================================
 * DER AUFNAHMEZUGANG — zwei Knöpfe mit UNTERSCHIEDLICHER Schwelle
 * ===========================================================================
 *
 * „Erneut senden" braucht KEINEN zweiten Faktor. Die Betreiberin erfährt
 * dabei nichts, was sie nicht schon weiß, und die Mail geht an eine Adresse,
 * die bereits im Datensatz steht — sie lässt sich nicht umlenken.
 *
 * „Link anzeigen" braucht ihn. Der Link führt zur IBAN-Erfassung; wer ihn
 * hat, kann für diese Organisation Bankdaten hinterlegen. Dieselbe Schwelle
 * wie beim Einrichtungslink der Instanz ([A.7]).
 *
 * DER LINK WIRD NICHT MIT DER KARTE GELADEN. Er entsteht erst auf Knopfdruck,
 * und der Wechsel auf eine andere Organisation setzt ihn zurück — sonst
 * stünde unter dem Namen von B der Link von A. Dieselbe Vorsicht wie in der
 * `InstanzKarte`.
 *
 * WAS DIE KARTE NICHT TUT: Sie fragt sich nicht selbst neu ab. Anders als bei
 * der Instanz arbeitet hier serverseitig nichts weiter; der nächste Schritt
 * liegt bei der Organisation, und der kann Tage dauern. Ein Takt, der Tage
 * lang ins Leere fragt, ist kein Fortschritt, sondern Last.
 */
export function IntakeCard({ companyId, totpPossible }: Props) {
  const t = useT();
  const toast = useToast();
  const evidenceState = useSecondFactorEvidence();
  const [state, setState] = useState<IntakeAccessState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [sends, setSends] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await fetchIntakeAccess(companyId));
      setLoadError(null);
    } catch (error) {
      setLoadError(errorText(error, t('components.intakeCard.text')));
    } finally {
      setLoaded(true);
    }
  }, [companyId]);

  useEffect(() => {
    // Der Klartext gehört zur VORHERIGEN Organisation und wird verworfen.
    setLink(null);
    setLoaded(false);
    void load();
  }, [load]);

  async function againSend() {
    setSends(true);
    try {
      const result = await sendIntakeLink(companyId);
      toast.show(
        result.sent
          ? t('components.intakeCard.text2', { email: result.email })
          : result.reason === 'no_address'
            ? t('components.intakeCard.text3')
            : t('components.intakeCard.text4'),
        result.sent ? 'success' : 'error',
      );
      await load();
    } catch (error) {
      toast.show(
        errorText(error, t('components.intakeCard.text5')),
        'error',
      );
    } finally {
      setSends(false);
    }
  }

  async function fetchLink(evidence?: SecondFactorEvidence) {
    setLinkLoading(true);
    try {
      const { link: newValue } = await showIntakeLink(companyId, evidence);
      setLink(newValue);
      evidenceState.close();
      await load();
    } catch (error) {
      if (evidenceState.handle(error, evidence)) return;
      toast.show(
        errorText(error, t('components.intakeCard.text6')),
        'error',
      );
    } finally {
      setLinkLoading(false);
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.show(t('components.intakeCard.text7'));
    } catch {
      toast.show(t('components.intakeCard.text8'), 'error');
    }
  }

  return (
    <Card className="mt-6 p-6" id="aufnahme">
      <h2 className="mb-4 text-lg font-semibold text-text">{t('components.intakeCard.heading')}</h2>

      {!loaded ? (
        <div aria-busy="true">
          <Skeleton className="mb-3 h-4 w-64" />
          <Skeleton className="h-9 w-48 rounded-lg" />
        </div>
      ) : loadError !== null ? (
        <>
          <p role="alert" className="mb-3 text-sm text-text">
            {loadError}
          </p>
          {/* Lädt nur nach. Es wird nichts geschrieben. */}
          <Button variant="secondary" onClick={() => void load()}>
            {t('components.intakeCard.button')}</Button>
        </>
      ) : (
        <div className="space-y-3 text-sm text-text">
          <p>{stateSet(state)}</p>

          {state?.lastSentAt != null && (
            <p className="text-leise">
              {t('components.intakeCard.text9')}{formatDate(state.lastSentAt)}
              {state.address != null ? ` an ${state.address}` : ''}
              {state.sendCount > 1 ? t('components.intakeCard.text10', { sendCount: state.sendCount }) : ''}
            </p>
          )}

          {state != null && state.address == null && (
            <p role="alert" className="text-leise">
              {t('components.intakeCard.text11')}</p>
          )}

          {/* Erst nach Eingang aussagekräftig: Vorher fehlt naturgemäß alles. */}
          {state?.completedAt != null && state.missing.length > 0 && (
            <div>
              <p className="mb-1">{t('components.intakeCard.text12')}</p>
              <ul className="list-disc pl-5 text-leise">
                {state.missing.map((info) => (
                  <li key={info.field}>{info.label}</li>
                ))}
              </ul>
            </div>
          )}

          {link !== null && (
            <div className="rounded-lg border border-rahmen bg-flaeche-2 p-3">
              {/* Er steht nur hier und nur jetzt — beim nächsten Laden ist er
                  weg, und ein neuer Aufruf erzeugt einen anderen. */}
              <p className="mb-2 text-leise">
                {t('components.intakeCard.text13')}</p>
              <div className="flex items-start gap-2">
                <code className="min-w-0 flex-1 break-all text-sm">{link}</code>
                <Button variant="ghost" onClick={() => void copy(link)}>
                  <Copy className="size-4" aria-hidden="true" />
                  {t('components.intakeCard.button2')}</Button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              variant="secondary"
              disabled={sends || state?.address == null}
              onClick={() => void againSend()}
            >
              <Mail className="size-4" aria-hidden="true" />
              {state?.lastSentAt != null ? t('components.intakeCard.button3') : t('components.intakeCard.button4')}
            </Button>
            <Button
              variant="secondary"
              disabled={linkLoading}
              onClick={() => void fetchLink()}
            >
              {t('components.intakeCard.button5')}</Button>
          </div>
        </div>
      )}

      <SecondFactorEvidenceDialog
        open={evidenceState.open}
        title={t('components.intakeCard.title')}
        declaration={
          t('components.intakeCard.declaration') +
          t('components.intakeCard.declaration2')
        }
        totpPossible={totpPossible}
        loading={linkLoading}
        error={evidenceState.error}
        onCancel={() => evidenceState.close()}
        onConfirm={(evidence) => void fetchLink(evidence)}
      />
    </Card>
  );
}

/** Der eine Satz, der den Stand zusammenfasst. */
function stateSet(state: IntakeAccessState | null): string {
  if (state == null) return t('components.intakeCard.text14');
  if (state.completedAt != null) {
    return t('components.intakeCard.text15', { value: formatDate(state.completedAt) });
  }
  if (!state.present) return t('components.intakeCard.text16');
  if (state.expired) {
    return state.expiresAt != null
      ? t('components.intakeCard.text17', { value: formatDate(state.expiresAt) }) +
          t('components.intakeCard.text18')
      : t('components.intakeCard.text19');
  }
  return state.expiresAt != null
    ? t('components.intakeCard.text20', { value: formatDate(state.expiresAt) })
    : t('components.intakeCard.text21');
}
