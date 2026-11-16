import { useEffect, type ReactNode } from 'react';
import { Spinner } from '@saas-instant/ui';
import { useVault } from '../context/VaultContext';
import { VaultSetupPage } from '../pages/VaultSetupPage';
import { VaultUnlockPage } from '../pages/VaultUnlockPage';
import { useT } from '../i18n';

/**
 * Tor vor dem angemeldeten Bereich: Ist die Verschlüsselung noch nicht
 * eingerichtet, kommt der Einrichtungsassistent; ist die Verwaltung gesperrt,
 * die Entsperrseite. Beides ersetzt die Seite, ohne die Adresse zu ändern —
 * nach dem Entsperren steht dieselbe Seite wieder da.
 */
export function VaultGate({ children }: { children: ReactNode }) {
  const t = useT();
  const { status, refresh } = useVault();

  useEffect(() => {
    if (status === 'unknown') void refresh();
  }, [status, refresh]);

  if (status === 'unknown') {
    return (
      <div className="grid min-h-dvh place-items-center bg-flaeche-2">
        <Spinner text={t('vault.statusChecking')} />
      </div>
    );
  }
  if (status === 'uninitialized') return <VaultSetupPage />;
  if (status === 'locked') return <VaultUnlockPage />;
  return <>{children}</>;
}
