import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card, NoticeBar } from '@saas-instant/ui';
import { PassphraseFields } from '../components/PassphraseFields';
import { RecoveryKeyPanel } from '../components/RecoveryKeyPanel';
import { SecondFactorEvidenceDialog } from '../components/SecondFactorEvidenceDialog';
import { StepIndicator } from '../components/StepIndicator';
import { useAuth } from '../context/AuthContext';
import { useVault } from '../context/VaultContext';
import { vaultSetup } from '../lib/api';
import type { SecondFactorEvidence } from '../lib/api';
import { ApiError, ERROR_CODE, errorText } from '../lib/api-client';
import { useSecondFactorEvidence } from '../lib/second-factor';
import { passphrasePairValid } from '../lib/vault';
import { useT } from '../i18n';

/**
 * Einrichtungsassistent der Datenverschlüsselung, einmalig beim ersten Start.
 *
 * Schritt 1: Passphrase (mit Stärkeanzeige und Wiederholung). Schritt 2: der
 * Wiederherstellungsschlüssel — einmalig sichtbar, mit Kopieren, TXT und
 * Drucken; weiter geht es erst mit dem Häkchen „sicher verwahrt".
 *
 * Der Schlüssel lebt nur in diesem Zustand. Das Tor (`VaultGate`) zeigt die
 * Seite so lange, bis `markUnlocked` gerufen wird, damit ein Neuladen oder
 * Zurück nicht unbemerkt den einzigen Blick auf den Schlüssel kostet; ein
 * Warnhinweis des Browsers beim Verlassen sichert das zusätzlich ab.
 */
export function VaultSetupPage() {
  const t = useT();
  const { state } = useAuth();
  const { refresh, markUnlocked } = useVault();
  const evidenceState = useSecondFactorEvidence();
  const [passphrase, setPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const stepNames = [t('vault.setupStepPassphrase'), t('vault.setupStepKey')];
  const stepIndex = recoveryKey === null ? 0 : 1;

  useEffect(() => {
    if (recoveryKey === null) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [recoveryKey]);

  async function submit(evidence?: SecondFactorEvidence): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const result = await vaultSetup(passphrase, evidence);
      evidenceState.close();
      setRecoveryKey(result.recoveryKey);
      // Die Passphrase muss nicht länger im Speicher der Seite liegen.
      setPassphrase('');
      setRepeat('');
    } catch (e) {
      if (evidenceState.handle(e, evidence)) return;
      if (e instanceof ApiError && e.error.code === ERROR_CODE.vaultAlreadyInitialized) {
        setError(t('vault.setupAlready'));
        void refresh();
        return;
      }
      setError(errorText(e, t('vault.setupFailed')));
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    if (!passphrasePairValid(passphrase, repeat) || loading) return;
    void submit();
  }

  return (
    <div className="flex min-h-dvh justify-center bg-flaeche-2 px-4 py-8">
      <div className="w-full max-w-xl">
        <h1 className="mb-4 text-2xl font-semibold tracking-tight text-text">
          {t('vault.setupTitle')}
        </h1>
        <StepIndicator steps={stepNames} activeIndex={stepIndex} />
        <Card className="mt-6 p-6 sm:p-8">
          {recoveryKey === null ? (
            <form onSubmit={onSubmit} className="text-left" noValidate>
              <p className="mb-3 text-sm text-leise">{t('vault.setupIntro')}</p>
              <NoticeBar kind="attention" className="mb-5">
                {t('vault.setupWarning')}
              </NoticeBar>
              <PassphraseFields
                idPrefix="vault-setup"
                value={passphrase}
                onValueChange={setPassphrase}
                repeat={repeat}
                onRepeatChange={setRepeat}
                disabled={loading}
                autoFocus
              />
              {error && (
                <p role="alert" className="mb-3 text-sm text-gefahr">
                  {error}
                </p>
              )}
              <Button
                type="submit"
                loading={loading}
                disabled={!passphrasePairValid(passphrase, repeat)}
                className="w-full"
              >
                {t('vault.setupSubmit')}
              </Button>
            </form>
          ) : (
            <div className="text-left">
              <p className="mb-4 text-sm text-leise">{t('vault.setupKeyIntro')}</p>
              <RecoveryKeyPanel
                recoveryKey={recoveryKey}
                confirmed={confirmed}
                onConfirmedChange={setConfirmed}
              />
              <div className="mt-5 print:hidden">
                <Button disabled={!confirmed} onClick={markUnlocked} className="w-full">
                  {t('vault.setupDone')}
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>

      <SecondFactorEvidenceDialog
        open={evidenceState.open}
        title={t('vault.setupEvidenceTitle')}
        declaration={t('vault.setupEvidenceReason')}
        totpPossible={state?.totpSetUp ?? false}
        loading={loading}
        error={evidenceState.error}
        onCancel={evidenceState.close}
        onConfirm={(evidence) => void submit(evidence)}
      />
    </div>
  );
}
