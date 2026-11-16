import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { fetchVaultStatus, type VaultState } from '../lib/api';
import { setVaultLockedHandler } from '../lib/api-client';
import { clearRecentCompanies } from '../lib/recent-companies';

/** `unknown`, solange der Zustand noch nicht abgefragt ist. */
export type VaultStatus = 'unknown' | VaultState;

interface VaultValues {
  status: VaultStatus;
  /** Fragt den Zustand beim Server ab. Ein Fehler sperrt nie aus (s. u.). */
  refresh: () => Promise<void>;
  /** Nach erfolgreichem Entsperren bzw. nach der Einrichtung. */
  markUnlocked: () => void;
}

const Context = createContext<VaultValues | null>(null);

/**
 * Hält den Zustand der Datenverschlüsselung und meldet den globalen
 * 423-Handler von `apiFetch` an: Stößt irgendeine Anfrage auf die Sperre,
 * wechselt der Zustand auf `locked`, und das Tor (`VaultGate`) zeigt die
 * Entsperrseite — an derselben Adresse, damit es danach genau dort weitergeht.
 */
export function VaultProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<VaultStatus>('unknown');

  useEffect(() => {
    setVaultLockedHandler(() => {
      // Gesperrt heißt: nichts Kundenbezogenes darf im Browser liegen bleiben.
      clearRecentCompanies();
      // Vor der Einrichtung gibt es nichts zu entsperren.
      setStatus((current) => (current === 'uninitialized' ? current : 'locked'));
    });
    return () => setVaultLockedHandler(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { state } = await fetchVaultStatus();
      setStatus(
        state === 'uninitialized' || state === 'locked' ? state : 'unlocked',
      );
    } catch {
      // Status nicht lesbar (Netz, älterer Server): nicht aussperren. Eine
      // echte Sperre fängt der 423-Handler bei der ersten Anfrage ab.
      setStatus('unlocked');
    }
  }, []);

  const markUnlocked = useCallback(() => setStatus('unlocked'), []);

  const value = useMemo(
    () => ({ status, refresh, markUnlocked }),
    [status, refresh, markUnlocked],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useVault(): VaultValues {
  const values = useContext(Context);
  if (!values) throw new Error('useVault must be used inside VaultProvider.');
  return values;
}
