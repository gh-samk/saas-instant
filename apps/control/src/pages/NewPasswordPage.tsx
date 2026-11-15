import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { AuthCard, Button, Spinner } from '@saas-instant/ui';
import { useProduct } from '../context/ProductContext';
import { PasswordWithStrength } from '../components/PasswordWithStrength';
import { useT } from '../i18n';
import { emergencyPasswordSet, emergencyCheck } from '../lib/api';
import { ApiError, errorText } from '../lib/api-client';
import { asRemainingDuration, useCountdown } from '../lib/countdown';
import { newPasswordValid, passwordStrength } from '../lib/password-strength';

type PageState = 'checking' | 'form' | 'invalid' | 'done';

/**
 * „Neues Passwort setzen" über den einmaligen Link aus dem CLI-Kommando
 * `emergency password <identifier>` (Pfad `/emergency-password?token=…`, so baut ihn
 * `EmergencyService`).
 *
 * Es gibt bewusst keinen Weg hierher über die Oberfläche: kein „Passwort
 * vergessen"-Link, kein Selbstbedienungs-Reset per E-Mail.
 */
export function NewPasswordPage() {
  const t = useT();
  const { productName, showBrand } = useProduct();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [state, setState] = useState<PageState>('checking');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [repeatError, setRepeatError] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /**
   * Restgültigkeit vom Server, in Sekunden. `null`, wenn das Backend das Feld
   * nicht mitliefert — dann läuft kein Countdown und es bleibt bei der festen
   * Angabe; geschätzt wird nichts.
   */
  const [startSeconds, setStartSeconds] = useState<number | null>(null);

  const remainingSeconds = useCountdown(startSeconds);

  useEffect(() => {
    if (!token) {
      setState('invalid');
      return;
    }
    void (async () => {
      try {
        const check = await emergencyCheck(token);
        if (!check.valid || check.kind !== 'password') {
          setState('invalid');
          return;
        }
        if (
          typeof check.secondsRemaining === 'number' &&
          check.secondsRemaining > 0
        ) {
          setStartSeconds(check.secondsRemaining);
        }
        setState('form');
      } catch {
        setState('invalid');
      }
    })();
  }, [token]);

  // Läuft der Link bei geöffnetem Formular ab, wechselt die Seite von selbst in
  // den Zustand „Link ungültig" — ohne dass jemand vergeblich absendet. Nicht
  // eingegebene Daten gehen dabei verloren; für ein Einmalgeheimnis ist das
  // richtig, ein Zwischenspeichern käme nicht in Frage.
  useEffect(() => {
    if (startSeconds !== null && remainingSeconds <= 0) {
      setState('invalid');
    }
  }, [remainingSeconds, startSeconds]);

  const matches = password === repeat;
  const valid = newPasswordValid(password, repeat);

  async function submit(): Promise<void> {
    setError(null);
    setLoading(true);
    try {
      await emergencyPasswordSet(token, password);
      setPassword('');
      setRepeat('');
      setState('done');
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 404)) {
        setState('invalid');
        return;
      }
      setError(errorText(e, t('passwort.setFailed')));
    } finally {
      setLoading(false);
    }
  }

  if (state === 'checking') {
    return (
      <AuthCard title={productName} brand={showBrand ? t('passwort.brand') : undefined} subtitle={t('passwort.subtitle')}>
        <Spinner text={t('passwort.checkingLink')} />
      </AuthCard>
    );
  }

  if (state === 'invalid') {
    return (
      <AuthCard title={productName} brand={showBrand ? t('passwort.brand') : undefined} subtitle={t('passwort.subtitle')}>
        <div className="flex items-start gap-3 text-left">
          <AlertTriangle
            className="mt-0.5 h-5 w-5 shrink-0 text-gefahr"
            aria-hidden="true"
          />
          <div>
            <p className="text-sm font-semibold text-text">{t('passwort.invalidTitle')}</p>
            <p className="mt-1 text-sm text-leise">{t('passwort.invalidText')}</p>
          </div>
        </div>
      </AuthCard>
    );
  }

  if (state === 'done') {
    return (
      <AuthCard title={productName} brand={showBrand ? t('passwort.brand') : undefined} subtitle={t('passwort.subtitle')}>
        <div className="flex items-center gap-2 text-left">
          <CheckCircle2 className="h-5 w-5 text-primaer" aria-hidden="true" />
          <p className="text-sm text-text">{t('passwort.doneText')}</p>
        </div>
        <Link
          to="/login"
          className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primaer px-4 py-3 text-base font-medium text-primaer-text transition-colors hover:bg-primaer-hover"
        >
          {t('passwort.toLogin')}
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={productName} brand={showBrand ? t('passwort.brand') : undefined} subtitle={t('passwort.subtitle')}>
      {startSeconds === null ? (
        <p className="mb-4 text-sm text-leise">{t('passwort.introNoCountdown')}</p>
      ) : (
        <p className="mb-4 text-sm text-leise" aria-live="polite">
          {t('passwort.introCountdownBefore')}{' '}
          <span className="ziffern-tabellarisch font-semibold text-text">
            {asRemainingDuration(remainingSeconds)}
          </span>{' '}
          {t('passwort.introCountdownAfter')}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
      >
        <PasswordWithStrength
          value={password}
          onValueChange={setPassword}
          repeatValue={repeat}
          onRepeatChange={setRepeat}
          strength={passwordStrength(password)}
          errorRepeat={repeatError}
          onRepeatLeave={() =>
            setRepeatError(
              repeat.length > 0 && !matches ? t('passwort.repeatMismatch') : undefined,
            )
          }
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
          disabled={!valid}
          className="w-full justify-center py-3 text-base"
        >
          {t('passwort.submit')}
        </Button>
      </form>
    </AuthCard>
  );
}
