import { AlertCircle, CheckCircle2, Fingerprint } from 'lucide-react';
import { Button } from '@saas-instant/ui';

export type PasskeyState = 'idle' | 'loading' | 'success' | 'error';

interface Props {
  state: PasskeyState;
  /** z. B. „Mit Passkey anmelden" / „Passkey erstellen". */
  label: string;
  /** z. B. „Warte auf Passkey …". */
  loadingLabel: string;
  /** Nur bei zustand="erfolg". */
  successLabel?: string;
  /** Nur bei zustand="fehler". */
  errorText?: string;
  onClick: () => void;
  /** gross = volle Breite (Anmeldung, Wizard); kompakt = Nebenaktion. */
  variant?: 'large' | 'compact';
  disabled?: boolean;
}

/**
 * Rein darstellende Schaltfläche für Passkey-Vorgänge. Die WebAuthn-Aufrufe
 * liegen bewusst beim Aufrufer: Anmeldung und Ersteinrichtung brauchen danach
 * unterschiedliches Verhalten, die Darstellung ist aber dieselbe.
 */
export function PasskeyButton({
  state,
  label,
  loadingLabel,
  successLabel,
  errorText,
  onClick,
  variant = 'large',
  disabled = false,
}: Props) {
  if (state === 'success') {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-rahmen bg-flaeche-2 px-3 py-2 text-sm text-text">
        <CheckCircle2 className="h-5 w-5 text-primaer" aria-hidden="true" />
        {successLabel}
      </div>
    );
  }

  const loading = state === 'loading';

  return (
    <div>
      {state === 'error' && errorText && (
        <p
          role="alert"
          className="mb-2 flex items-center gap-2 text-sm text-gefahr"
        >
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {errorText}
        </p>
      )}
      <Button
        variant={variant === 'large' ? 'primary' : 'secondaryGreen'}
        onClick={onClick}
        loading={loading}
        disabled={disabled}
        className={
          variant === 'large'
            ? 'w-full justify-center gap-2 py-3 text-base'
            : 'gap-2'
        }
      >
        {!loading && <Fingerprint className="h-5 w-5" aria-hidden="true" />}
        {loading ? loadingLabel : label}
      </Button>
    </div>
  );
}
