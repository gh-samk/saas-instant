import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRound, LifeBuoy, Lock, Mail } from 'lucide-react';
import { AuthCard, InputField, Button, Tabs } from '@saas-instant/ui';
import { PasskeyButton } from '../components/PasskeyButton';
import type { PasskeyState } from '../components/PasskeyButton';
import { EmailCodeInput } from '../components/EmailCodeInput';
import { TotpInput } from '../components/TotpInput';
import { RecoveryCodeInput } from '../components/RecoveryCodeInput';
import { useAuth } from '../context/AuthContext';
import { useProduct } from '../context/ProductContext';
import {
  loginCodeRequest,
  login,
  passkeyLoginComplete,
  passkeyLoginStart,
  secondFactorEmailCode,
  secondFactorTotp,
  secondFactorRecoveryCode,
} from '../lib/api';
import type { FactorKind } from '../lib/api';
import { ApiError, errorText, blockSecondsFrom } from '../lib/api-client';
import { emailCodeMessageFrom } from '../lib/email-code-error';
import { asMinutesSeconds, useCountdown } from '../lib/countdown';
import { TEXT_BUTTON } from '../lib/styles';
import { passkeyLogin, passkeysPossible } from '../lib/webauthn';
import { useT } from '../i18n';

function useTexts() {
  const t = useT();
  return {
  credentialsWrong: t('auth.credentialsWrong'),
  totpWrong: t('auth.codeWrongRetry'),
  // Der Anmeldeweg schickt bewusst nur „Anmeldung fehlgeschlagen." mit —
  // dieser Text ist deshalb der Rückfall, nicht die Meldung des Servers.
  emailWrong: t('auth.codeWrongRetry'),
  codeWrong:
    t('auth.recoveryCodeInvalid'),
  codeSendError:
    t('auth.codeSendFailed'),
  passkeyError:
    t('auth.passkeyFailed'),
  } as const;
}

/** Die beiden Faktoren, die als Schritt 2 nach dem Passwort in Frage kommen. */
type SecondFactor = 'email' | 'totp';

/** Setzt den Fokus zurück in ein Codefeld und markiert den Inhalt. */
function focusField(id: string): void {
  const field = document.getElementById(id);
  if (field instanceof HTMLInputElement) {
    field.focus();
    field.select();
  }
}

/**
 * Übersetzt die Faktorliste des Servers in die Methoden, die auf dieser Seite
 * als zweiter Schritt anwählbar sind. `passkey` fällt bewusst weg: ein Passkey
 * ist ein eigener, dem Passwort vorgelagerter Weg und keine Fortsetzung nach
 * der Passworteingabe — es gibt keine WebAuthn-Zeremonie nach dem Passwort.
 */
function asSecondFactors(factors: FactorKind[]): SecondFactor[] {
  const order: SecondFactor[] = ['email', 'totp'];
  return order.filter((m) =>
    factors.includes(m === 'email' ? 'email-code' : 'totp'),
  );
}

export function LoginPage() {
  const t = useT();
  const TEXT = useTexts();
  const { productName, showBrand, logoUrl } = useProduct();
  const navigate = useNavigate();
  const { reload } = useAuth();

  const [step, setStep] = useState<'credentials' | 'secondFactor'>(
    'credentials',
  );
  /** Im zweiten Schritt: die Faktoren-Ansicht oder der Ausnahmeweg. */
  const [view, setView] = useState<'factors' | 'recovery'>(
    'factors',
  );
  const [methods, setMethods] = useState<SecondFactor[]>([]);
  /**
   * Die Faktorliste des Servers, ungefiltert.
   *
   * `methoden` enthält nur, was als Schritt 2 wählbar ist — daraus lässt sich
   * NICHT ablesen, warum nichts wählbar ist. Ein Konto ganz ohne Faktor und
   * eines mit ausschließlich einem Passkey sehen dort gleich aus, brauchen
   * aber gegensätzliche Auskünfte. Deshalb hier die rohe Liste.
   */
  const [factors, setFactors] = useState<FactorKind[]>([]);
  /**
   * Die Methode, von der aus in den Wiederherstellungscode gewechselt wurde.
   * `Reiter` hat keinen kontrollierten Wert (Prämisse 0 der Spezifikation),
   * deshalb setzt jede Unteransicht diesen Wert beim Wechsel selbst — der
   * Rückweg führt so dorthin zurück, woher die Person kam.
   */
  const [lastMethod, setLastMethod] = useState<SecondFactor>('totp');

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberedDevice, setRememberedDevice] = useState(false);

  // Beide Unteransichten bleiben laut `Reiter` gleichzeitig im DOM (nur per
  // `hidden` ausgeblendet). Getrennter Zustand je Feld, sonst taucht ein
  // Tippfehler aus dem einen Feld beim Umschalten im anderen wieder auf.
  const [totpCode, setTotpCode] = useState('');
  const [totpError, setTotpError] = useState<string | null>(null);
  const [emailCode, setEmailCode] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(false);
  /**
   * Der zuletzt eingegebene Code ist verbrannt oder abgelaufen. Dann hilft
   * kein weiterer Tippversuch, sondern nur ein neuer Code — und der Weg
   * dorthin muss sichtbar sein, auch während der 60-Sekunden-Sperre.
   */
  const [newCodeRequired, setNewCodeRequired] = useState(false);
  const [sendLoading, setSendLoading] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [recoveryError, setRecoveryError] = useState<
    string | null
  >(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passkeyState, setPasskeyState] = useState<PasskeyState>('idle');
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [blockSeconds, setBlockSeconds] = useState<number | null>(null);

  // Wiederhol-Sperre für „Code erneut senden". Die Anmelderoute antwortet
  // immer gleich und liefert keine Restzeit — gezählt wird ab dem eigenen
  // Absenden. `runde` startet den Zähler bei gleichbleibenden 60 s neu.
  const [cooldownSeconds, setCooldownSeconds] = useState<number | null>(null);
  const [cooldownRound, setCooldownRound] = useState(0);
  const cooldown = useCountdown(cooldownSeconds, cooldownRound);

  const restBlock = useCountdown(blockSeconds);
  const blocked = blockSeconds !== null && restBlock > 0;

  /** Leert alles, was zum zweiten Schritt gehört. */
  function clearSecondStepFrom(): void {
    setTotpCode('');
    setTotpError(null);
    setEmailCode('');
    setEmailError(null);
    setEmailSent(false);
    setNewCodeRequired(false);
    setRecoveryCode('');
    setRecoveryError(null);
    setCooldownSeconds(null);
  }

  // Sperre endet von selbst: zurück zu Schritt 1, ohne Neuladen der Seite.
  useEffect(() => {
    if (blockSeconds !== null && restBlock <= 0) {
      setBlockSeconds(null);
      setStep('credentials');
      setView('factors');
      setPassword('');
      setError(null);
      clearSecondStepFrom();
    }
  }, [restBlock, blockSeconds]);

  const passkeyAvailable = passkeysPossible();

  /** Übernimmt einen Serverfehler; erkennt die Kontosperre gesondert. */
  function handleError(
    e: unknown,
    fallbackText: string,
    show: (text: string) => void,
  ): void {
    const seconds = blockSecondsFrom(e);
    if (seconds !== null) {
      setBlockSeconds(seconds);
      setError(null);
      setPasskeyError(null);
      setTotpError(null);
      setEmailError(null);
      setRecoveryError(null);
      return;
    }
    if (e instanceof ApiError && e.status !== 401) {
      // Kein Silent Failure: unerwartete Serverfehler sichtbar machen. Der
      // Ratenbegrenzer antwortet ebenfalls mit 429, aber ohne fachlichen Code —
      // `fehlertext` setzt dafür die deutsche Meldung ein.
      show(errorText(e, fallbackText));
      return;
    }
    show(fallbackText);
  }

  async function finishLogin(): Promise<void> {
    await reload();
    navigate('/');
  }

  async function credentialsSubmit(ev: React.FormEvent): Promise<void> {
    ev.preventDefault();
    setError(null);
    setPasskeyError(null);
    setLoading(true);
    try {
      const response = await login(username, password);
      if ('secondFactorRequired' in response) {
        const available = asSecondFactors(response.factors);
        setFactors(response.factors);
        setMethods(available);
        setLastMethod(available[0] ?? 'totp');
        // Ist ausschließlich ein Passkey eingerichtet, bleibt über den
        // Passwortweg nur der Wiederherstellungscode.
        setView(available.length === 0 ? 'recovery' : 'factors');
        clearSecondStepFrom();
        setStep('secondFactor');
        return;
      }
      await finishLogin();
    } catch (e) {
      handleError(e, TEXT.credentialsWrong, setError);
    } finally {
      setLoading(false);
    }
  }

  async function totpSubmit(): Promise<void> {
    setTotpError(null);
    setLoading(true);
    try {
      await secondFactorTotp(totpCode, rememberedDevice);
      await finishLogin();
    } catch (e) {
      handleError(e, TEXT.totpWrong, setTotpError);
      focusField('totp-code');
    } finally {
      setLoading(false);
    }
  }

  async function emailCodeSubmit(): Promise<void> {
    setEmailError(null);
    setLoading(true);
    try {
      await secondFactorEmailCode(emailCode, rememberedDevice);
      await finishLogin();
    } catch (e) {
      const { text, newCodeRequired: deadCode } = emailCodeMessageFrom(e);
      setNewCodeRequired(deadCode);
      handleError(e, text ?? TEXT.emailWrong, setEmailError);
      if (deadCode) {
        // Den toten Code stehen zu lassen lädt zum Weitertippen ein.
        setEmailCode('');
      } else {
        focusField('email-code');
      }
    } finally {
      setLoading(false);
    }
  }

  async function recoverySubmit(): Promise<void> {
    setRecoveryError(null);
    setLoading(true);
    try {
      await secondFactorRecoveryCode(recoveryCode.trim());
      await finishLogin();
    } catch (e) {
      handleError(e, TEXT.codeWrong, setRecoveryError);
    } finally {
      setLoading(false);
    }
  }

  /**
   * Fordert einen Anmeldecode an. Der Server antwortet auch dann mit Erfolg,
   * wenn die 60-Sekunden-Sperre greift — das ist Absicht (Enumerationsschutz),
   * und deshalb zählt die Oberfläche ab dem eigenen Absenden herunter.
   */
  async function codeSend(): Promise<void> {
    setSendLoading(true);
    setEmailError(null);
    try {
      const response = await loginCodeRequest(username);
      setEmailCode('');
      setEmailSent(true);
      setNewCodeRequired(false);
      setCooldownSeconds(response.againPossibleInSeconds);
      setCooldownRound((r) => r + 1);
    } catch (e) {
      handleError(e, TEXT.codeSendError, setEmailError);
    } finally {
      setSendLoading(false);
    }
  }

  async function withPasskeyLogin(): Promise<void> {
    setError(null);
    setPasskeyError(null);
    setPasskeyState('loading');
    try {
      const { options } = await passkeyLoginStart();
      const response = await passkeyLogin(options);
      await passkeyLoginComplete(response);
      await finishLogin();
    } catch (e) {
      const seconds = blockSecondsFrom(e);
      if (seconds !== null) {
        setBlockSeconds(seconds);
        setPasskeyState('idle');
        return;
      }
      setPasskeyError(TEXT.passkeyError);
      setPasskeyState('error');
    }
  }

  function backToPassword(): void {
    setStep('credentials');
    setView('factors');
    setFactors([]);
    setMethods([]);
    setPassword('');
    setError(null);
    clearSecondStepFrom();
  }

  /**
   * Was im Ausnahmeweg über dem Codefeld steht.
   *
   * Behauptet wird nur, was die Faktorliste des Servers hergibt: Ein Satz über
   * einen Passkey, den es gar nicht gibt, ist die schlechteste aller
   * Auskünfte — er schickt jemanden auf einen Weg, der nicht existiert.
   */
  function hintRecovery(): string {
    if (methods.length > 0) {
      return t('auth.recoveryHintWithMethods');
    }
    if (factors.includes('passkey')) {
      return t('auth.recoveryHintPasskeyOnly');
    }
    return t('auth.recoveryHintNoFactor');
  }

  function toRecoveryCode(from: SecondFactor): void {
    setLastMethod(from);
    setRecoveryCode('');
    setRecoveryError(null);
    setView('recovery');
  }

  /** Ankreuzfeld „Gerät merken" — in beiden Faktor-Unteransichten gleich. */
  function rememberedDeviceField() {
    return (
      <label className="mb-4 flex items-start gap-2 text-sm text-text">
        <input
          type="checkbox"
          checked={rememberedDevice}
          onChange={(e) => setRememberedDevice(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-rahmen-ui text-primaer"
        />
        <span>{t('auth.trustDeviceLabel')}<span className="block text-xs font-normal text-leise">{t('auth.trustDeviceHint')}</span>
        </span>
      </label>
    );
  }

  /** Fußzeile beider Faktor-Unteransichten: zurück oder Ausnahmeweg. */
  function factorFooterLine(from: SecondFactor) {
    return (
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
        <button type="button" className={TEXT_BUTTON} onClick={backToPassword}>{t('auth.backToLogin')}</button>
        <button
          type="button"
          className={TEXT_BUTTON}
          onClick={() => toRecoveryCode(from)}
        >{t('auth.useRecoveryCodeInstead')}</button>
      </div>
    );
  }

  function totpSubview() {
    return (
      <>
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-rahmen bg-flaeche-2 p-3 text-left">
          <KeyRound
            className="mt-0.5 h-5 w-5 shrink-0 text-primaer"
            aria-hidden="true"
          />
          <p className="text-sm text-leise">{t('auth.totpPrompt')}</p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void totpSubmit();
          }}
          noValidate
        >
          <TotpInput
            value={totpCode}
            onValueChange={setTotpCode}
            error={totpError ?? undefined}
            disabled={loading}
          />
          {rememberedDeviceField()}
          <Button
            type="submit"
            loading={loading}
            disabled={totpCode.length !== 6}
            className="w-full justify-center py-3 text-base"
          >{t('auth.submitLogin')}</Button>
        </form>
        {factorFooterLine('totp')}
      </>
    );
  }

  function emailSubview() {
    return (
      <>
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-rahmen bg-flaeche-2 p-3 text-left">
          <Mail
            className="mt-0.5 h-5 w-5 shrink-0 text-primaer"
            aria-hidden="true"
          />
          {/* Die Zieladresse steht hier bewusst NICHT: Schritt 1 liefert sie
              nicht mit, und sie nachzufragen hieße, sie unauthentifiziert
              herauszugeben. Wer den Code bekommt, sieht die Adresse im
              Postfach; ändern lässt sie sich angemeldet in den Einstellungen. */}
          <p className="text-sm text-leise">
            {emailSent
              ? t('auth.emailCodeSentHint', { hint: t('auth.codeValidHint') })
              : t('auth.emailCodeWillBeSentHint')}
          </p>
        </div>
        {!emailSent ? (
          <>
            <Button
              onClick={() => void codeSend()}
              loading={sendLoading}
              className="w-full justify-center py-3 text-base"
            >{t('auth.sendCode')}</Button>
            {emailError && (
              <p role="alert" className="mt-3 text-sm text-gefahr">
                {emailError}
              </p>
            )}
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void emailCodeSubmit();
            }}
            noValidate
          >
            <EmailCodeInput
              value={emailCode}
              onValueChange={setEmailCode}
              error={emailError ?? undefined}
              disabled={loading}
            />
            {rememberedDeviceField()}
            <Button
              type="submit"
              loading={loading}
              disabled={emailCode.length !== 8}
              className="w-full justify-center py-3 text-base"
            >{t('auth.submitLogin')}</Button>
            {/* Ist der Code tot, fordert die Meldung darüber einen neuen an —
                dann muss hier auch ein Weg dorthin stehen und nicht bloß eine
                Wartezeit. Der Knopf bleibt während der Sperre bewusst weg
                (kein toter Knopf), die Zeile sagt aber, worauf man wartet. */}
            <div className="mt-3 text-sm">
              {cooldown > 0 ? (
                <span className="text-leise">
                  {newCodeRequired ? t('auth.requestNewCodeIn') : t('auth.resendIn')}
                  <span className="ziffern-tabellarisch">{cooldown}</span>{t('auth.secondsUnit')}</span>
              ) : (
                <button
                  type="button"
                  className={TEXT_BUTTON}
                  onClick={() => void codeSend()}
                >
                  {newCodeRequired ? t('auth.requestNewCode') : t('auth.resendCode')}
                </button>
              )}
            </div>
          </form>
        )}
        {factorFooterLine('email')}
      </>
    );
  }

  if (blocked) {
    return (
      <AuthCard logoUrl={logoUrl} title={productName} brand={showBrand ? t('auth.brand') : undefined} subtitle={t('auth.loginSubtitle')}>
        <div className="rounded-lg border border-rahmen bg-flaeche-2 p-4 text-left">
          <div className="mb-2 flex items-center gap-2">
            <Lock className="h-5 w-5 text-gefahr" aria-hidden="true" />
            <p className="text-sm font-semibold text-text">{t('auth.lockedTitle')}</p>
          </div>
          <p className="text-sm text-leise" aria-live="polite">{t('auth.lockedBeforeTime')}{' '}
            <span className="ziffern-tabellarisch font-semibold text-gefahr">
              {asMinutesSeconds(restBlock)}
            </span>{' '}{t('auth.lockedAfterTime')}</p>
        </div>
      </AuthCard>
    );
  }

  if (step === 'secondFactor') {
    return (
      <AuthCard logoUrl={logoUrl} title={productName} brand={showBrand ? t('auth.brand') : undefined} subtitle={t('auth.confirmationSubtitle')}>
        {view === 'recovery' ? (
          <>
            <div className="mb-4 flex items-start gap-3 rounded-lg border border-rahmen bg-flaeche-2 p-3 text-left">
              <LifeBuoy
                className="mt-0.5 h-5 w-5 shrink-0 text-primaer"
                aria-hidden="true"
              />
              <p className="text-sm text-leise">
                {hintRecovery()}
              </p>
            </div>
            <RecoveryCodeInput
              value={recoveryCode}
              onValueChange={setRecoveryCode}
              onSubmit={() => void recoverySubmit()}
              error={recoveryError ?? undefined}
              loading={loading}
            />
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
              <button
                type="button"
                className={TEXT_BUTTON}
                onClick={backToPassword}
              >{t('auth.backToLogin')}</button>
              {methods.length > 0 && (
                <button
                  type="button"
                  className={TEXT_BUTTON}
                  onClick={() => {
                    setRecoveryCode('');
                    setRecoveryError(null);
                    setView('factors');
                  }}
                >{t('auth.backToConfirmationCode')}</button>
              )}
            </div>
          </>
        ) : methods.length > 1 ? (
          <Tabs
            entries={[
              {
                key: 'email',
                title: 'E-Mail-Code',
                content: emailSubview(),
              },
              {
                key: 'totp',
                title: t('auth.authenticatorApp'),
                content: totpSubview(),
              },
            ]}
            startKey={lastMethod}
          />
        ) : methods[0] === 'email' ? (
          emailSubview()
        ) : (
          totpSubview()
        )}
      </AuthCard>
    );
  }

  return (
    <AuthCard logoUrl={logoUrl} title={productName} brand={showBrand ? t('auth.brand') : undefined} subtitle={t('auth.loginSubtitle')}>
      {passkeyAvailable && (
        <>
          <PasskeyButton
            state={passkeyState}
            label={t('auth.passkeyLogin')}
            loadingLabel={t('auth.passkeyWaiting')}
            errorText={passkeyError ?? undefined}
            onClick={() => void withPasskeyLogin()}
            variant="large"
            disabled={loading}
          />
          <div className="my-4 flex items-center gap-3" role="presentation">
            <span className="h-px flex-1 bg-rahmen" aria-hidden="true" />
            <span className="text-xs font-medium uppercase tracking-wide text-leise">{t('auth.orWithCredentials')}</span>
            <span className="h-px flex-1 bg-rahmen" aria-hidden="true" />
          </div>
        </>
      )}

      <form onSubmit={(e) => void credentialsSubmit(e)} noValidate>
        <InputField
          id="benutzername"
          label={t('auth.usernameLabel')}
          autoComplete="username"
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={loading}
        />
        <InputField
          id="password"
          label={t('auth.passwordLabel')}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={loading}
        />
        {error && (
          <p role="alert" className="mb-4 text-sm text-gefahr">
            {error}
          </p>
        )}
        <Button
          type="submit"
          loading={loading}
          disabled={!username || !password}
          className="w-full justify-center py-3 text-base"
        >{t('auth.submitLogin')}</Button>
      </form>
    </AuthCard>
  );
}
