import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, errorText, fetchCsrf } from '../lib/api-client';;
import { logout as logoutCall, fetchState } from '../lib/api';
import type { AccessState } from '../lib/api';
import { useT } from '../i18n';

interface AuthValues {
  /** Stand des angemeldeten Kontos, oder null wenn niemand angemeldet ist. */
  state: AccessState | null;
  /** true, solange der erste Abruf von /api/auth/me läuft. */
  loading: boolean;
  /** Der erste Abruf ist gescheitert (Server nicht erreichbar o. Ä.). */
  error: string | null;
  /** Lädt den Stand neu — nach Anmeldung, TOTP-Einrichtung, Codewechsel. */
  reload: () => Promise<void>;
  logout: () => Promise<void>;
}

const Context = createContext<AuthValues | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [state, setState] = useState<AccessState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setState(await fetchState());
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setState(null);
        setError(null);
        return;
      }
      // Kein Silent Failure: alles andere ist ein echter Fehler und wird
      // angezeigt, statt als „nicht angemeldet" durchzugehen.
      setError(
        errorText(e, t('common.authContext.text')),
      );
      throw e;
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await fetchCsrf();
        await reload();
      } catch {
        // Der Grund steht bereits in `fehler`; hier nur den Ladezustand beenden.
      } finally {
        setLoading(false);
      }
    })();
  }, [reload]);

  const logout = useCallback(async () => {
    try {
      await logoutCall();
    } finally {
      setState(null);
    }
  }, []);

  return (
    <Context.Provider value={{ state, loading, error, reload, logout }}>
      {children}
    </Context.Provider>
  );
}

export function useAuth(): AuthValues {
  const t = useT();
  const values = useContext(Context);
  if (!values) {
    throw new Error(t('common.authContext.error'));
  }
  return values;
}
