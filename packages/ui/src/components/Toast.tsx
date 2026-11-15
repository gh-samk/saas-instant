import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import { CheckCircle2, AlertCircle, X } from 'lucide-react';
import { uiT } from '../i18n';

type ToastType = 'success' | 'error';
interface ToastEntry {
  id: number;
  message: string;
  typeValue: ToastType;
}

interface ToastContext {
  show: (message: string, typeValue?: ToastType) => void;
}

const Context = createContext<ToastContext | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<ToastEntry[]>([]);

  const remove = useCallback((id: number) => {
    setList((l) => l.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (message: string, typeValue: ToastType = 'success') => {
      const id = Date.now() + Math.random();
      setList((l) => [...l, { id, message, typeValue }]);
      // Auto-Dismiss nach 4 s.
      setTimeout(() => remove(id), 4000);
    },
    [remove],
  );

  return (
    <Context.Provider value={{ show }}>
      {children}
      {/* aria-live=polite: kündigt an, ohne den Fokus zu stehlen. */}
      <div
        className="fixed bottom-4 right-4 z-50 flex flex-col gap-2"
        aria-live="polite"
        aria-atomic="false"
      >
        {list.map((t) => {
          const Icon = t.typeValue === 'success' ? CheckCircle2 : AlertCircle;
          return (
            <div
              key={t.id}
              role="status"
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm shadow-toast ${
                t.typeValue === 'success'
                  ? 'border-beschluss-rahmen bg-beschluss-bg text-beschluss-text'
                  : 'border-einwand-rahmen bg-einwand-bg text-einwand-text'
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span>{t.message}</span>
              <button
                onClick={() => remove(t.id)}
                aria-label={uiT('toast.close')}
                className="ml-1 rounded-md p-0.5 opacity-80 transition-opacity duration-150 hover:opacity-100"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </Context.Provider>
  );
}

export function useToast(): ToastContext {
  const ctx = useContext(Context);
  if (!ctx) throw new Error(uiT('toast.outsideProvider'));
  return ctx;
}
