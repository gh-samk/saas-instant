import { useId, useRef, useState, type ReactNode } from 'react';

export interface TabsEntry {
  key: string;
  title: string;
  content: ReactNode;
}

/**
 * Barrierefreie Tabs: role=tablist/tab/tabpanel, Pfeiltasten-Navigation,
 * aria-selected. Roving tabindex (nur der aktive Tab ist fokussierbar).
 */
export function Tabs({
  entries,
  startKey,
}: {
  entries: TabsEntry[];
  /** Anfangs aktiver Reiter (per Schlüssel); Standard: erster. */
  startKey?: string;
}) {
  const [active, setActive] = useState(() => {
    const i = entries.findIndex((e) => e.key === startKey);
    return i >= 0 ? i : 0;
  });
  const basisId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const direction = e.key === 'ArrowRight' ? 1 : -1;
      const next = (active + direction + entries.length) % entries.length;
      setActive(next);
      refs.current[next]?.focus();
    }
  }

  return (
    <div>
      <div role="tablist" className="flex gap-1 border-b border-rahmen" onKeyDown={onKey}>
        {entries.map((e, i) => {
          const selected = i === active;
          return (
            <button
              key={e.key}
              ref={(el) => {
                refs.current[i] = el;
              }}
              role="tab"
              id={`${basisId}-tab-${i}`}
              aria-selected={selected}
              aria-controls={`${basisId}-panel-${i}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(i)}
              className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
                selected
                  ? 'border-primaer text-primaer'
                  : 'border-transparent text-leise hover:text-text'
              }`}
            >
              {e.title}
            </button>
          );
        })}
      </div>
      {entries.map((e, i) => (
        <div
          key={e.key}
          role="tabpanel"
          id={`${basisId}-panel-${i}`}
          aria-labelledby={`${basisId}-tab-${i}`}
          hidden={i !== active}
          className="pt-4"
        >
          {e.content}
        </div>
      ))}
    </div>
  );
}
