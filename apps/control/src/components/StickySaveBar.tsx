import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@saas-instant/ui';
import { useT } from '../i18n';

/**
 * Knöpfe in der Leiste: mobil 44 px hoch und enger gesetzt, ab `sm` die
 * gewohnte Größe. Auch für die Knöpfe, die ein Formular in `actions`/`idle` liefert.
 */
export const BAR_BUTTON = 'min-h-11 max-sm:px-2.5 sm:min-h-10';
/** Wie `BAR_BUTTON`, für den Textknopf ohne Rand (Verwerfen, Abbrechen): noch enger. */
export const BAR_BUTTON_GHOST = 'min-h-11 max-sm:px-2 sm:min-h-10';

/** Luft zwischen einem angescrollten Feld und der Leiste (Fokusring inbegriffen). */
const SCROLL_GAP = 8;

/** Platz, den die Leiste beansprucht, bevor sie einmal gemessen wurde (eine Zeile). */
const FALLBACK_HEIGHT = '4.5rem';

/**
 * Feste Speicherleiste am unteren Rand des Inhaltsbereichs.
 *
 * Sichtbar nur bei ungespeicherten Änderungen: „Ungespeicherte Änderungen ·
 * Verwerfen · Speichern". Mit `idle` bleibt sie auch ohne Änderungen stehen und
 * zeigt dann diesen Inhalt (Formulare, deren Aktionen nie verschwinden dürfen).
 *
 * `position: sticky` statt `fixed`: Die Leiste folgt der Spalte, in der sie
 * steht, und liegt deshalb nie über der Seitenleiste. Sie gehört ans ENDE des
 * Formulars, direkt im Inhaltsbereich (`main` mit seitlichem Rand). Der Platzhalter
 * steht immer da, damit beim Erscheinen nichts springt, und folgt der
 * GEMESSENEN Höhe der Leiste (`ResizeObserver`): Ein fester Wert war kleiner als
 * die zweizeilige Leiste bei 375 px und der letzte Inhalt blieb darunter.
 * Diese Höhe plus etwas Luft steht als `scroll-padding-bottom` am Dokument, solange die
 * Leiste sichtbar ist — so scrollen `focus()`, Tab und `scrollIntoView` nie
 * hinter die Leiste. Unten gilt die Safe-Area (Notch, Home-Indikator);
 * `prefers-reduced-motion` schaltet das Einblenden ab.
 *
 * Mobil bleibt die Leiste einzeilig: Der Hinweis „Ungespeicherte Änderungen"
 * schrumpft zum Punkt (Vorleseprogramme lesen ihn weiter), die Knöpfe sind
 * knapper gesetzt, behalten aber 44 px Trefferfläche (`BAR_BUTTON`).
 * Gemessen bei 375 px passen Verwerfen, Speichern und Festschreiben … samt
 * Punkt gerade in eine Zeile.
 *
 * Strg/Cmd+S speichert, solange Änderungen vorliegen.
 */
export function StickySaveBar({
  dirty,
  onSave,
  onDiscard,
  saving = false,
  error = null,
  label,
  saveLabel,
  actions,
  idle,
  shortcut = true,
}: {
  dirty: boolean;
  onSave: () => void | Promise<unknown>;
  /** Setzt das Formular auf den letzten gespeicherten Stand zurück. */
  onDiscard: () => void;
  saving?: boolean;
  /** Fehler des letzten Speicherversuchs; steht in der Leiste, nicht weit davon. */
  error?: string | null;
  /** Name der Region für Vorleseprogramme. */
  label?: string;
  /** Beschriftung von „Speichern" (z. B. „Als Entwurf speichern"). */
  saveLabel?: string;
  /** Weitere Aktionen rechts neben „Speichern", nur bei Änderungen. */
  actions?: ReactNode;
  /** Inhalt ohne Änderungen. Gesetzt: Leiste ist immer sichtbar. */
  idle?: ReactNode;
  shortcut?: boolean;
}) {
  const t = useT();

  useEffect(() => {
    if (!shortcut || !dirty || saving) return;
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void onSave();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [shortcut, dirty, saving, onSave]);

  const visible = dirty || idle !== undefined;

  // GEMESSENE HÖHE: Der Platzhalter behält die zuletzt gemessene Höhe, auch
  // wenn die Leiste gerade ausgeblendet ist — sonst spränge der Inhalt beim
  // Erscheinen. Ohne `ResizeObserver` (Tests, sehr alte Browser) bleibt es bei
  // der Messung beim Rendern.
  const barRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const measure = () => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      if (h > 0) setHeight((old) => (old === h ? old : h));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible || height === null) return;
    const root = document.documentElement;
    const before = root.style.scrollPaddingBottom;
    root.style.scrollPaddingBottom = `${height + SCROLL_GAP}px`;
    return () => {
      root.style.scrollPaddingBottom = before;
    };
  }, [visible, height]);

  return (
    <div
      className="sticky bottom-0 z-20 mt-6"
      style={{ minHeight: height === null ? FALLBACK_HEIGHT : `${height}px` }}
    >
      {visible && (
        <div
          ref={barRef}
          role="region"
          aria-label={label ?? t('unsaved.bar.region')}
          className="-mx-4 border-t border-rahmen bg-flaeche px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-4px_12px_rgba(0,0,0,0.06)] transition duration-200 starting:translate-y-2 starting:opacity-0 motion-reduce:transition-none lg:-mx-6 lg:px-6"
        >
          {error && (
            <p role="alert" className="mb-2 text-sm text-gefahr">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-2 sm:gap-x-3">
            {dirty ? (
              <>
                <p className="mr-auto flex items-center gap-2 text-sm font-medium text-text">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-primaer" aria-hidden="true" />
                  <span className="sr-only sm:not-sr-only">{t('unsaved.bar.message')}</span>
                </p>
                <Button
                  variant="ghost"
                  type="button"
                  className={BAR_BUTTON_GHOST}
                  disabled={saving}
                  onClick={onDiscard}
                >
                  {t('unsaved.bar.discard')}
                </Button>
                <Button
                  variant="primary"
                  type="button"
                  className={BAR_BUTTON}
                  loading={saving}
                  onClick={() => void onSave()}
                >
                  {saveLabel ?? t('unsaved.bar.save')}
                </Button>
                {actions}
              </>
            ) : (
              idle
            )}
          </div>
        </div>
      )}
    </div>
  );
}
