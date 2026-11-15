import { InputField } from '@saas-instant/ui';
import { useT } from '../i18n';

interface Props {
  value: string;
  onValueChange: (value: string) => void;
  error?: string;
  disabled?: boolean;
  /** Standard: „Bestätigungscode". */
  label?: string;
}

/**
 * Reines Eingabefeld für den sechsstelligen Code aus der Authenticator-App.
 * Formular und Absende-Knopf liegen beim Aufrufer: Anmeldung und
 * Ersteinrichtung brauchen unterschiedliche Elemente darunter.
 */
export function TotpInput({
  value,
  onValueChange,
  error,
  disabled,
  label,
}: Props) {
  const t = useT();
  return (
    <InputField
      id="totp-code"
      label={label ?? t('components.totpInput.label')}
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={6}
      autoFocus
      value={value}
      onChange={(e) => onValueChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
      error={error}
      disabled={disabled}
    />
  );
}
