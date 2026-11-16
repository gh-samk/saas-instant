import { useState } from 'react';
import { InputField } from '@saas-instant/ui';
import { PasswordStrengthIndicator } from './PasswordStrengthIndicator';
import { passwordStrength } from '../lib/password-strength';
import { useT } from '../i18n';

interface Props {
  /** Macht die Feld-IDs eindeutig, wenn zwei Formulare gleichzeitig existieren. */
  idPrefix: string;
  value: string;
  onValueChange: (value: string) => void;
  repeat: string;
  onRepeatChange: (value: string) => void;
  /** Beschriftung des ersten Felds; Vorgabe „Passphrase". */
  label?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}

/**
 * Neue Passphrase plus Wiederholung mit Stärkeanzeige. Die Übereinstimmung
 * wird erst beim Verlassen des Wiederholungsfelds gemeldet, nicht während
 * des Tippens. Die Stärke ist ein Hinweis, die Länge (12) ist die Pflicht.
 */
export function PassphraseFields({
  idPrefix,
  value,
  onValueChange,
  repeat,
  onRepeatChange,
  label,
  disabled,
  autoFocus,
}: Props) {
  const t = useT();
  const [left, setLeft] = useState(false);
  const mismatch = left && repeat.length > 0 && repeat !== value;
  return (
    <>
      <InputField
        id={`${idPrefix}-passphrase`}
        label={label ?? t('vault.passphraseLabel')}
        type="password"
        autoComplete="new-password"
        helperText={t('vault.passphraseHint')}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        disabled={disabled}
        autoFocus={autoFocus}
      />
      <PasswordStrengthIndicator strength={passwordStrength(value)} />
      <InputField
        id={`${idPrefix}-repeat`}
        label={t('vault.passphraseRepeatLabel')}
        type="password"
        autoComplete="new-password"
        value={repeat}
        onChange={(e) => onRepeatChange(e.target.value)}
        onBlur={() => setLeft(true)}
        error={mismatch ? t('vault.passphraseMismatch') : undefined}
        disabled={disabled}
      />
    </>
  );
}
