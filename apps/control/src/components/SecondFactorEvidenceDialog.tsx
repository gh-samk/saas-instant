import { useState } from 'react';
import { Dialog, InputField, Button } from '@saas-instant/ui';
import { TotpInput } from './TotpInput';
import { TEXT_BUTTON } from '../lib/styles';
import type { SecondFactorEvidence } from '../lib/api';
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

  function close(): void {
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
        </>
      }
    >
      <p className="mb-4 text-leise">{declaration}</p>
      {activeKind === 'password' ? (
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
