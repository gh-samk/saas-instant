import { useEffect, useRef, useState } from 'react';
import { Dialog, InputField, Button } from '@saas-instant/ui';
import { TotpInput } from './TotpInput';
import { TEXT_BUTTON } from '../lib/styles';
import type { SecondFactorEvidence } from '../lib/api';
import {
  STEP_UP_DONE_PATH,
  listenStepUp,
  stepUpChannelAvailable,
  ssoStartUrl,
  useViaPortal,
} from '../lib/portal-session';
import { useT } from '../i18n';

interface Props {
  open: boolean;
  title: string;
  /** Warum hier noch einmal nachgefragt wird. */
  declaration: string;
  /** Blendet den TOTP-Umschalter aus, wenn keine App eingerichtet ist. */
  totpPossible: boolean;
  loading: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: (evidence: SecondFactorEvidence) => void;
}

/**
 * Fragt vor sicherheitsrelevanten Änderungen noch einmal nach, wer da sitzt:
 * aktuelles Passwort ODER Bestätigungscode aus der Authenticator-App.
 *
 * Ein Sitzungs-Cookie allein reicht dem Server dafür nicht. Wer keine
 * Authenticator-App eingerichtet hat — etwa mit dem E-Mail-Code als einzigem
 * Faktor —, bekommt den Umschalter gar nicht erst angeboten: Der Server nimmt
 * dort nur das Passwort an, und ein Weg, der ins Leere führt, ist schlimmer
 * als keiner.
 *
 * In einer Portal-Sitzung gibt es weder Passwort noch Authenticator-App als
 * Nachweis: Der Nachweis ist ein frischer Durchlauf beim Portal (Step-up, in
 * einem eigenen Fenster). Danach wird die Aktion mit leerem Nachweis
 * wiederholt — der Server prüft den Step-up an der Sitzung.
 */
export function SecondFactorEvidenceDialog({
  open,
  title,
  declaration,
  totpPossible,
  loading,
  error,
  onCancel,
  onConfirm,
}: Props) {
  const t = useT();
  const [kind, setKind] = useState<'password' | 'totp'>('password');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');

  // Ohne Authenticator-App gibt es nur den Passwortweg, auch wenn zuvor schon
  // einmal umgeschaltet wurde.
  const activeKind = totpPossible ? kind : 'password';

  const viaPortal = useViaPortal();
  const [waiting, setWaiting] = useState(false);
  const [stepUpError, setStepUpError] = useState<string | null>(null);
  const popup = useRef<Window | null>(null);
  // Nur ein laufendes Step-up wird ausgewertet: Doppelte oder verspätete
  // Meldungen (z. B. StrictMode im Dev-Betrieb) lösen die Bestätigung nicht
  // ein zweites Mal aus.
  const awaiting = useRef(false);
  const confirmRef = useRef(onConfirm);
  confirmRef.current = onConfirm;

  // Das Step-up-Fenster meldet sein Ergebnis über einen BroadcastChannel. Ob
  // es abgebrochen wurde, lässt sich nicht erkennen (COOP des Portals); dafür
  // gibt es „Abbrechen" und ein Zeitlimit von fünf Minuten.
  useEffect(() => {
    if (!viaPortal || !open) return;
    const stop = listenStepUp((ok) => {
      if (!awaiting.current) return;
      awaiting.current = false;
      setWaiting(false);
      if (ok) {
        setStepUpError(null);
        confirmRef.current({});
      } else {
        setStepUpError(t('sso.stepUpFailed'));
      }
    });
    const limit = window.setTimeout(() => {
      awaiting.current = false;
      setWaiting(false);
    }, 5 * 60 * 1000);
    return () => {
      stop();
      window.clearTimeout(limit);
    };
  }, [viaPortal, open, t]);

  function startStepUp(): void {
    setStepUpError(null);
    if (!stepUpChannelAvailable()) {
      // Ohne Rückkanal: im selben Tab zum Portal und danach hierher zurück.
      window.location.assign(
        ssoStartUrl(`${window.location.pathname}${window.location.search}`, true),
      );
      return;
    }
    const opened = window.open(
      ssoStartUrl(STEP_UP_DONE_PATH, true),
      'si-step-up',
      'popup,width=520,height=760',
    );
    if (!opened) {
      setStepUpError(t('sso.stepUpBlocked'));
      return;
    }
    popup.current = opened;
    awaiting.current = true;
    setWaiting(true);
  }

  function close(): void {
    popup.current?.close();
    popup.current = null;
    awaiting.current = false;
    setWaiting(false);
    setStepUpError(null);
    setPassword('');
    setCode('');
    setKind('password');
    onCancel();
  }

  return (
    <Dialog
      open={open}
      title={title}
      size="sm"
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('components.secondFactorEvidenceDialog.button')}</Button>
          {viaPortal ? (
            <Button loading={loading || waiting} onClick={startStepUp}>
              {t('sso.stepUpButton')}
            </Button>
          ) : (
          <Button
            loading={loading}
            disabled={
              activeKind === 'password' ? password.length === 0 : code.length !== 6
            }
            onClick={() =>
              onConfirm(
                activeKind === 'password'
                  ? { currentPassword: password }
                  : { totpCode: code },
              )
            }
          >
            {t('components.secondFactorEvidenceDialog.button2')}</Button>
          )}
        </>
      }
    >
      <p className="mb-4 text-leise">{declaration}</p>
      {viaPortal ? (
        <>
          <p className="text-sm text-leise">{t('sso.stepUpHint')}</p>
          {waiting && (
            <p role="status" className="mt-3 text-sm text-leise">
              {t('sso.stepUpWaiting')}
            </p>
          )}
          {(stepUpError ?? error) && (
            <p role="alert" className="mt-3 text-sm text-gefahr">
              {stepUpError ?? error}
            </p>
          )}
        </>
      ) : activeKind === 'password' ? (
        <>
          <InputField
            id="nachweis-passwort"
            label={t('components.secondFactorEvidenceDialog.label')}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={error}
            disabled={loading}
          />
          {totpPossible && (
            <button
              type="button"
              className={`text-sm ${TEXT_BUTTON}`}
              onClick={() => setKind('totp')}
            >
              {t('components.secondFactorEvidenceDialog.button3')}</button>
          )}
        </>
      ) : (
        <>
          <TotpInput
            value={code}
            onValueChange={setCode}
            error={error}
            disabled={loading}
          />
          <button
            type="button"
            className={`text-sm ${TEXT_BUTTON}`}
            onClick={() => setKind('password')}
          >
            {t('components.secondFactorEvidenceDialog.button4')}</button>
        </>
      )}
    </Dialog>
  );
}
