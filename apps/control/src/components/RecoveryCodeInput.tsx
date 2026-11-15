import { InputField, Button } from '@saas-instant/ui';
import { useT } from '../i18n';

interface Props {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  error?: string;
  loading?: boolean;
}

/** Ausnahmeweg im zweiten Anmeldeschritt: einer der acht Einmalcodes. */
export function RecoveryCodeInput({
  value,
  onValueChange,
  onSubmit,
  error,
  loading,
}: Props) {
  const t = useT();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      noValidate
    >
      <InputField
        id="wiederherstellungscode"
        label={t('components.recoveryCodeInput.label')}
        placeholder="xxxx-xxxx"
        autoComplete="off"
        autoFocus
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        error={error}
        disabled={loading}
      />
      <Button
        type="submit"
        className="w-full justify-center py-3 text-base"
        loading={loading}
        disabled={!value.trim()}
      >
        {t('components.recoveryCodeInput.button')}</Button>
    </form>
  );
}
