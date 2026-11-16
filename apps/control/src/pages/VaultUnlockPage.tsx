import { useState, type FormEvent } from 'react';
import { AuthCard, Button, InputField } from '@saas-instant/ui';
import { useAuth } from '../context/AuthContext';
import { useProduct } from '../context/ProductContext';
import { useVault } from '../context/VaultContext';
import { vaultUnlock } from '../lib/api';
import { ApiError, ERROR_CODE } from '../lib/api-client';
import { sessionDead } from '../lib/second-factor';
import { TEXT_BUTTON } from '../lib/styles';
import { unlockErrorText } from '../lib/vault';
import { useT } from '../i18n';

/**
 * Entsperrseite. Erscheint automatisch, wenn der Server mit 423 antwortet
 * (globaler Handler in `apiFetch`) oder der Zustand „gesperrt" ist. Die
 * Adresse bleibt unverändert; nach dem Entsperren steht dieselbe Seite da.
 *
 * Ein Feld, ein Knopf. Der Wiederherstellungsschlüssel ist der Ausweg, kein
 * zweites Formular: ein Link tauscht nur Beschriftung und Eingabeart.
 */
export function VaultUnlockPage() {
  const t = useT();
  const { productName, logoUrl } = useProduct();
  const { reload, logout } = useAuth();
  const { markUnlocked, refresh } = useVault();
  const [mode, setMode] = useState<'passphrase' | 'key'>('passphrase');
  const [secret, setSecret] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function switchMode(next: 'passphrase' | 'key'): void {
    setMode(next);
    setSecret('');
    setError(null);
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (secret.trim() === '' || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await vaultUnlock(secret.trim());
      if (result.state === 'unlocked') {
        setSecret('');
        markUnlocked();
        return;
      }
      setError(t('vault.unlockFailed'));
    } catch (f) {
      if (sessionDead(f)) {
        // Sitzung abgelaufen: AuthProvider setzt auf „abgemeldet", der
        // geschützte Bereich führt zur Anmeldung.
        void reload().catch(() => undefined);
        return;
      }
      if (f instanceof ApiError && f.error.code === ERROR_CODE.vaultUninitialized) {
        void refresh();
        return;
      }
      setError(unlockErrorText(f, mode));
    } finally {
      setLoading(false);
    }
  }

  const isKey = mode === 'key';
  return (
    <AuthCard
      logoUrl={logoUrl}
      title={t('vault.unlockTitle')}
      brand={productName}
      subtitle={isKey ? t('vault.unlockSubtitleKey') : t('vault.unlockSubtitle')}
    >
      <form onSubmit={(e) => void submit(e)} noValidate>
        <InputField
          id="vault-unlock-secret"
          label={isKey ? t('vault.recoveryKeyLabel') : t('vault.passphraseLabel')}
          type={isKey ? 'text' : 'password'}
          autoComplete={isKey ? 'off' : 'current-password'}
          autoCapitalize={isKey ? 'characters' : 'off'}
          spellCheck={false}
          autoFocus
          helperText={isKey ? t('vault.unlockKeyHint') : undefined}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          error={error ?? undefined}
          disabled={loading}
        />
        <Button type="submit" loading={loading} disabled={secret.trim() === ''} className="w-full">
          {t('vault.unlockButton')}
        </Button>
      </form>
      <div className="mt-4 flex flex-col items-center gap-2 text-sm">
        <button
          type="button"
          className={TEXT_BUTTON}
          onClick={() => switchMode(isKey ? 'passphrase' : 'key')}
        >
          {isKey ? t('vault.unlockWithPassphrase') : t('vault.unlockWithKey')}
        </button>
        <button type="button" className={`text-leise underline underline-offset-2`} onClick={() => void logout()}>
          {t('vault.unlockSignOut')}
        </button>
      </div>
    </AuthCard>
  );
}
