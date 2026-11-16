import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  UNSAFE_NavigationContext as NavigationContext,
  createPath,
  useLocation,
  type Navigator,
} from 'react-router-dom';
import { Button, Dialog } from '@saas-instant/ui';
import { useT } from '../i18n';

/**
 * Struktureller Vergleich für den Änderungsstand: Zahlen, Texte, Wahrheitswerte,
 * Listen und einfache Objekte, unabhängig von der Reihenfolge der Schlüssel.
 * `undefined` und fehlende Schlüssel gelten als gleich.
 */
export function stableEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => stableEqual(item, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!stableEqual(left[key], right[key])) return false;
  }
  return true;
}

/**
 * Änderungsstand eines Formulars: vergleicht den aktuellen Stand mit dem
 * zuletzt gespeicherten.
 *
 * `current` ist ein Abbild aller bearbeitbaren Felder (ohne reine
 * Anzeigezustände wie „aufgeklappt"). Der erste Stand ist der gespeicherte,
 * wenn kein `initial` übergeben wird. `markSaved()` übernimmt den aktuellen
 * Stand (oder das Ergebnis des Aktualisierers) als neuen gespeicherten Stand
 * — und zwar SOFORT, auch für `isDirty()`: Wer direkt danach navigiert, wird
 * nicht mehr gewarnt. `baseline` ist der Stand, auf den „Verwerfen" zurückgeht.
 */
export function useDirtyState<T>(
  current: T,
  options: { initial?: T; equals?: (a: T, b: T) => boolean } = {},
) {
  const equals = options.equals ?? stableEqual;
  const baselineRef = useRef<T>(options.initial ?? current);
  const currentRef = useRef(current);
  currentRef.current = current;
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  const isDirty = useCallback(
    () => !equals(baselineRef.current, currentRef.current),
    // `equals` ist in der Praxis stabil oder die Vorgabe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const markSaved = useCallback((update?: (current: T) => T) => {
    baselineRef.current = update ? update(currentRef.current) : currentRef.current;
    rerender();
  }, []);

  return {
    dirty: !equals(baselineRef.current, current),
    baseline: baselineRef.current,
    isDirty,
    markSaved,
  };
}

interface Registry {
  register: (id: string, isDirty: () => boolean) => () => void;
}

const RegistryContext = createContext<Registry | null>(null);

/**
 * Meldet ein Formular mit ungespeicherten Änderungen an. Solange `dirty` wahr
 * ist (oder die Funktion `true` liefert), fragt der `UnsavedChangesProvider`
 * beim Wechsel der Seite oder des Reiters nach und warnt beim Schließen des
 * Browser-Fensters. Ohne Provider (etwa in Einzeltests) tut der Hook nichts.
 */
export function useUnsavedChanges(dirty: boolean | (() => boolean)) {
  const registry = useContext(RegistryContext);
  const id = useId();
  const ref = useRef(dirty);
  ref.current = dirty;
  useEffect(() => {
    if (registry === null) return;
    return registry.register(id, () =>
      typeof ref.current === 'function' ? ref.current() : ref.current,
    );
  }, [registry, id]);
}

function targetPath(to: Parameters<Navigator['push']>[0]): string {
  return typeof to === 'string' ? to : createPath(to);
}

/**
 * Fängt Navigation bei ungespeicherten Änderungen ab.
 *
 * KEIN DATA-ROUTER: Die Anwendung nutzt `BrowserRouter`, `useBlocker` gibt es
 * dort nicht. Stattdessen wird der `navigator` des Routers umhüllt. Jede
 * Navigation über `<Link>`, `navigate()` und `setSearchParams` läuft durch
 * ihn — auch der Reiterwechsel in den Einstellungen, der ein Suchparameter
 * ist. Ändert sich das Ziel und ist ein angemeldetes Formular ungespeichert,
 * öffnet sich der Dialog, die Navigation wartet. `beforeunload` deckt Neuladen
 * und Schließen ab. NICHT abgedeckt: der Zurück-Knopf des Browsers (`popstate`
 * lässt sich nicht aufhalten, ohne den Verlauf zu verbiegen).
 */
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const { navigator: base } = useContext(NavigationContext);
  const location = useLocation();
  const here = `${location.pathname}${location.search}${location.hash}`;
  const hereRef = useRef(here);
  hereRef.current = here;

  const guards = useRef(new Map<string, () => boolean>());
  const [pending, setPending] = useState<(() => void) | null>(null);

  const anyDirty = useCallback(
    () => [...guards.current.values()].some((isDirty) => isDirty()),
    [],
  );

  const registry = useMemo<Registry>(
    () => ({
      register(id, isDirty) {
        guards.current.set(id, isDirty);
        return () => {
          guards.current.delete(id);
        };
      },
    }),
    [],
  );

  const guarded = useMemo<Navigator>(() => {
    const intercept = (run: () => void, to?: string) => {
      const leaving = to === undefined || to !== hereRef.current;
      if (leaving && anyDirty()) setPending(() => run);
      else run();
    };
    return {
      ...base,
      push: (to, state, opts) =>
        intercept(() => base.push(to, state, opts), targetPath(to)),
      replace: (to, state, opts) =>
        intercept(() => base.replace(to, state, opts), targetPath(to)),
      go: (delta) => intercept(() => base.go(delta)),
    };
  }, [base, anyDirty]);

  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (!anyDirty()) return;
      // Die Browser zeigen ihren eigenen Text; Setzen genügt.
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [anyDirty]);

  function leave() {
    const run = pending;
    setPending(null);
    // `run` ruft den ungeschützten Navigator: kein zweites Nachfragen.
    run?.();
  }

  const navigationContext = useContext(NavigationContext);
  const value = useMemo(
    () => ({ ...navigationContext, navigator: guarded }),
    [navigationContext, guarded],
  );

  return (
    <RegistryContext.Provider value={registry}>
      <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>
      <Dialog
        open={pending !== null}
        title={t('unsaved.leave.title')}
        size="sm"
        onClose={() => setPending(null)}
        footer={
          <>
            <Button variant="secondary" autoFocus onClick={() => setPending(null)}>
              {t('unsaved.leave.stay')}
            </Button>
            <Button variant="danger" onClick={leave}>
              {t('unsaved.leave.confirm')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-text">{t('unsaved.leave.text')}</p>
      </Dialog>
    </RegistryContext.Provider>
  );
}
