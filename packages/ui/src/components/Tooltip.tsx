import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

/** Mindestabstand des Tooltips zum Fensterrand. */
const EDGE_GAP = 8;

/**
 * Kurzinfo, die per Hover UND per Tastaturfokus erscheint (nicht nur Hover).
 * Der Trigger ist fokussierbar; der Text ist als role=tooltip verknüpft.
 *
 * Der Text bricht um (höchstens 17 rem breit) und wird beim Einblenden in den
 * sichtbaren Bereich geschoben. Ausgeblendet ist er `hidden`, nicht nur
 * durchsichtig: Ein unsichtbarer, aber noch belegter Kasten verbreitert sonst
 * die Seite und macht sie seitlich scrollbar. Für Vorleseprogramme bleibt er
 * über `aria-describedby` trotzdem erreichbar.
 *
 * Mit `label` ist der Trigger ein echter `<button type="button">` (Name aus
 * `label`, mindestens 24 × 24 px groß); ohne `label` ein fokussierbares `span`
 * um den übergebenen Inhalt.
 */
export function Tooltip({
  text,
  children,
  label,
}: {
  text: string;
  children: ReactNode;
  label?: string;
}) {
  const [visible, setVisible] = useState(false);
  const id = useId();
  const tipRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!visible || !tip) return;
    tip.style.transform = 'translateX(-50%)';
    const rect = tip.getBoundingClientRect();
    const max = document.documentElement.clientWidth - EDGE_GAP;
    let shift = 0;
    if (rect.left < EDGE_GAP) shift = EDGE_GAP - rect.left;
    else if (rect.right > max) shift = max - rect.right;
    if (shift !== 0) tip.style.transform = `translateX(calc(-50% + ${shift}px))`;
  }, [visible]);

  const triggerProps = {
    tabIndex: 0,
    'aria-describedby': id,
    onMouseEnter: () => setVisible(true),
    onMouseLeave: () => setVisible(false),
    onFocus: () => setVisible(true),
    onBlur: () => setVisible(false),
    // Escape schließt die Kurzinfo, ohne den Fokus zu verschieben (WCAG 1.4.13).
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Escape' && visible) {
        e.stopPropagation();
        setVisible(false);
      }
    },
  };

  return (
    <span className="relative inline-flex">
      {label !== undefined ? (
        <button
          type="button"
          aria-label={label}
          {...triggerProps}
          className="inline-flex h-6 w-6 cursor-help items-center justify-center rounded-md"
        >
          {children}
        </button>
      ) : (
        <span {...triggerProps} className="inline-flex cursor-help">
          {children}
        </span>
      )}
      <span
        ref={tipRef}
        role="tooltip"
        id={id}
        style={{ transform: 'translateX(-50%)' }}
        className={`pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 w-max max-w-[min(17rem,calc(100vw-1rem))] whitespace-normal rounded-md border border-rahmen bg-flaeche px-2 py-1 text-left text-xs text-text shadow-karte ${
          visible ? 'block' : 'hidden'
        }`}
      >
        {text}
      </span>
    </span>
  );
}
