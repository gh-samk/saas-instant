import { InputField } from '@saas-instant/ui';
import { PasswordStrengthIndicator } from './PasswordStrengthIndicator';
import type { PasswordStrength } from '../lib/password-strength';
import { useT } from '../i18n';

interface Props {
  value: string;
  onValueChange: (value: string) => void;
  repeatValue: string;
  onRepeatChange: (value: string) => void;
  strength: PasswordStrength;
  /** Wird erst beim Verlassen des Wiederholungsfelds gesetzt. */
  errorRepeat?: string;
  /** Prüft die Übereinstimmung beim Verlassen des Wiederholungsfelds. */
  onRepeatLeave?: () => void;
  disabled?: boolean;
}

/** Neues Passwort plus Wiederholung, mit Stärkeanzeige dazwischen. */
export function PasswordWithStrength({
  value,
  onValueChange,
  repeatValue,
  onRepeatChange,
  strength,
  errorRepeat,
  onRepeatLeave,
  disabled,
}: Props) {
  const t = useT();
  return (
    <>
      <InputField
        id="neues-passwort"
        label={t('components.passwordWithStrength.label')}
        type="password"
        autoComplete="new-password"
        helperText={t('components.passwordWithStrength.helperText')}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        disabled={disabled}
      />
      <PasswordStrengthIndicator strength={strength} />
      <InputField
        id="passwort-wiederholen"
        label={t('components.passwordWithStrength.label2')}
        type="password"
        autoComplete="new-password"
        value={repeatValue}
        onChange={(e) => onRepeatChange(e.target.value)}
        onBlur={onRepeatLeave}
        error={errorRepeat}
        disabled={disabled}
      />
    </>
  );
}
