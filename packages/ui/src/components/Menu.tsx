import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { ChevronDown } from 'lucide-react';

/** Mindestabstand des Menüs zum Fensterrand. */
const EDGE_GAP = 8;

/** Ein Eintrag des Menüs: eine Aktion (`onSelect`) oder ein Verweis (`href`). */
export interface MenuItem {
  id: string;
  label: ReactNode;
  /** Erklärender Satz unter der Beschriftung. */
  description?: ReactNode;
  /** Kleine Marke hinter der Beschriftung, etwa „Empfohlen". */
  badge?: ReactNode;
  /**
   * Mit `href` wird der Eintrag ein echtes `<a>`: Mittelklick und „Link in
   * neuem Tab öffnen" funktionieren weiter, `onSelect` kann den Klick
   * abfangen (`event.preventDefault()`).
   */
  href?: string;
  onSelect?: (event: ReactMouseEvent<HTMLElement>) => void;
  /** Zerstörende Aktion: Schrift in Warnfarbe, ohne dauerhaft Alarm zu machen. */
  tone?: 'normal' | 'danger';
}

interface Props {
  /** Beschriftung des Knopfes, der das Menü öffnet. */
  label: ReactNode;
  /** Nur für Knöpfe ohne sichtbaren Text (etwa „⋯"): der zugängliche Name. */
  ariaLabel?: string;
  items: MenuItem[];
  /** Symbol vor der Beschriftung. */
  icon?: ReactNode;
  /** Ohne Pfeil hinter der Beschriftung (für „⋯"). */
  hideChevron?: boolean;
  variant?: 'secondary' | 'ghost';
  /** Kante des Knopfes, an der das Menü ausgerichtet wird. */
  align?: 'start' | 'end';
  className?: string;
}

const TRIGGER_STYLES: Record<NonNullable<Props['variant']>, string> = {
  secondary:
    'bg-flaeche text-text border border-rahmen-ui hover:bg-flaeche-3',
  ghost: 'text-text hover:bg-flaeche-3',
};

/**
 * Aufklappmenü („Menu Button"-Muster der WAI-ARIA Authoring Practices).
 *
 * Der Knopf trägt `aria-haspopup="menu"` und `aria-expanded`. Geöffnet wird
 * per Klick, Enter, Leertaste oder Pfeil; im Menü bewegen die Pfeiltasten
 * (mit Umbruch), Pos1/Ende springen an die Ränder. Escape schließt und gibt
 * den Fokus an den Knopf zurück, ebenso die Wahl eines Eintrags. Ein Klick
 * außerhalb oder Tab schließt, ohne den Fokus zu holen — dort will die
 * Benutzerin ohnehin hin.
 *
 * Das geöffnete Menü bricht nie aus dem Fenster aus: Es wird nach dem
 * Einblenden in den sichtbaren Bereich geschoben (wie `Tooltip`), sonst liefe
 * es bei 375 px seitlich über.
 */
export function Menu({
  label,
  ariaLabel,
  items,
  icon,
  hideChevron = false,
  variant = 'secondary',
  align = 'end',
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** Welcher Eintrag beim Öffnen den Fokus bekommt: erster, letzter oder keiner. */
  const focusOnOpen = useRef<'first' | 'last' | null>(null);
  const id = useId();

  const entries = useCallback(
    (): HTMLElement[] =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ??
          [],
      ),
    [],
  );

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // Fokus ins Menü, sobald es steht.
  useEffect(() => {
    if (!open) return;
    const list = entries();
    const target =
      focusOnOpen.current === 'last' ? list[list.length - 1] : list[0];
    target?.focus();
    focusOnOpen.current = null;
  }, [open, entries]);

  // Klick außerhalb schließt.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent | MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  // In den sichtbaren Bereich schieben.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    panel.style.transform = '';
    const rect = panel.getBoundingClientRect();
    const max = document.documentElement.clientWidth - EDGE_GAP;
    let shift = 0;
    if (rect.left < EDGE_GAP) shift = EDGE_GAP - rect.left;
    else if (rect.right > max) shift = max - rect.right;
    if (shift !== 0) panel.style.transform = `translateX(${shift}px)`;
  }, [open]);

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusOnOpen.current = 'first';
      setOpen(true);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusOnOpen.current = 'last';
      setOpen(true);
    }
  }

  function onPanelKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const list = entries();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => {
      event.preventDefault();
      list[(next + list.length) % list.length]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        move(index + 1);
        break;
      case 'ArrowUp':
        move(index <= 0 ? list.length - 1 : index - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(list.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  }

  const itemClass = (tone: MenuItem['tone']) =>
    `flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm outline-none hover:bg-flaeche-3 focus-visible:bg-flaeche-3 ${
      tone === 'danger' ? 'text-gefahr' : 'text-text'
    }`;

  return (
    <div ref={rootRef} className={`relative inline-block ${className ?? ''}`}>
      <button
        ref={triggerRef}
        type="button"
        id={`${id}-trigger`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        aria-label={ariaLabel}
        onClick={() => {
          focusOnOpen.current = 'first';
          setOpen((v) => !v);
        }}
        onKeyDown={onTriggerKeyDown}
        className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors duration-150 ${TRIGGER_STYLES[variant]}`}
      >
        {icon}
        {label}
        {!hideChevron && (
          <ChevronDown
            className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        )}
      </button>
      {open && (
        <div
          ref={panelRef}
          id={`${id}-menu`}
          role="menu"
          aria-labelledby={`${id}-trigger`}
          onKeyDown={onPanelKeyDown}
          className={`absolute z-30 mt-1 w-max min-w-56 max-w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-rahmen bg-flaeche py-1 shadow-lg ${
            align === 'end' ? 'right-0' : 'left-0'
          }`}
        >
          {items.map((item) => {
            const content = (
              <>
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {item.label}
                  {item.badge !== undefined && (
                    <span className="rounded-full bg-primaer-soft px-2 py-0.5 text-xs font-semibold text-primaer">
                      {item.badge}
                    </span>
                  )}
                </span>
                {item.description !== undefined && (
                  <span className="text-xs font-normal text-leise">
                    {item.description}
                  </span>
                )}
              </>
            );
            const select = (event: ReactMouseEvent<HTMLElement>) => {
              item.onSelect?.(event);
              close(true);
            };
            return item.href !== undefined ? (
              <a
                key={item.id}
                role="menuitem"
                tabIndex={-1}
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={select}
                className={itemClass(item.tone)}
              >
                {content}
              </a>
            ) : (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={select}
                className={itemClass(item.tone)}
              >
                {content}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
