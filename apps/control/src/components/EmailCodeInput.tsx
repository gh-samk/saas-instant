import { InputField } from '@saas-instant/ui';
import { useT } from '../i18n';

interface Props {
  value: string;
  onValueChange: (value: string) => void;
  error?: string;
  disabled?: boolean;
  /** Standard: „Code aus der E-Mail". */
  label?: string;
}

/**
 * Reines Eingabefeld für den achtstelligen Code aus der E-Mail. Aufbau bewusst
 * identisch zu `TotpEingabe`, nur acht statt sechs Ziffern.
 *
 * Formular, Absende-Knopf und der Wiederhol-Zähler („Erneut senden in {n} s")
 * liegen beim Aufrufer: Anmeldung, Ersteinrichtung und Einstellungen brauchen
 * darunter jeweils andere Elemente.
 */
export function EmailCodeInput({
  value,
  onValueChange,
  error,
  disabled,
  label,
}: Props) {
  const t = useT();
  return (
    <InputField
      id="email-code"
      label={label ?? t('components.emailCodeInput.label')}
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={8}
      autoFocus
      value={value}
      onChange={(e) =>
        onValueChange(e.target.value.replace(/\D/g, '').slice(0, 8))
      }
      error={error}
      disabled={disabled}
    />
  );
}
