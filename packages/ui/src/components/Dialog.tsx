import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { uiT } from '../i18n';

/**
 * Modaler Dialog: Scrim, Esc/Hintergrundklick schließt, Fokus wandert in den
 * Dialog und wird darin gehalten (einfache Fokusfalle), role=dialog + aria-modal.
 */
const SIZE_CLASS = {
  sm: 'max-w-md',
  lg: 'max-w-2xl',
  xl: 'max-w-3xl',
} as const;

/**
 * Stapel offener Dialoge (LIFO). Nur der oberste reagiert auf Escape/Tab, damit
 * bei gestapelten Modals (z. B. Korrektur über Vorschlag-Detail) Escape nicht
 * beide gleichzeitig schließt.
 */
const dialogStack: string[] = [];

export function Dialog({
  open,
  title,
  eyebrow,
  head,
  onClose,
  children,
  footer,
  size = 'sm',
  ownHead = false,
}: {
  open: boolean;
  title: string;
  /** Kleines Label über dem Titel; macht den Titel zum Serifen-Großtitel. */
  eyebrow?: string;
  /** Ersetzt den eingebauten Eyebrow/Titel-Block (X + Padding bleiben). */
  head?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Buttons unten: erscheinen immer als graue Bande mit Trennlinie (einheitlich). */
  footer?: ReactNode;
  size?: 'sm' | 'lg' | 'xl';
  /**
   * Der Inhalt bringt seinen eigenen Kopf mit (z. B. das Vorschlag-Detail): die
   * eingebaute Titelzeile entfällt, das Schließen-X schwebt oben rechts und der
   * Panel bekommt einen durchgehenden blauen Top-Rand.
   */
  ownHead?: boolean;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const beforeFocus = useRef<HTMLElement | null>(null);
  const warOpen = useRef(false);

  /**
   * DEN AUSLÖSER BEIM ÖFFNEN MERKEN — IM RENDERN, NICHT IM EFFEKT.
   *
   * React wertet `autoFocus` im Commit aus, also VOR dem Effekt unten. Hat der
   * Inhalt ein Feld mit `autoFocus`, stünde dort sonst schon dieses Feld als
   * „vorher fokussiert" — und beim Schließen ginge der Fokus an ein Element,
   * das es dann nicht mehr gibt: er landete auf <body>. Im Rendern ist der
   * Auslöser noch der aktive Knopf. Nur beim Übergang zu/offen, damit ein
   * erneutes Rendern bei offenem Dialog nichts überschreibt.
   */
  if (open && !warOpen.current && typeof document !== 'undefined') {
    beforeFocus.current = document.activeElement as HTMLElement | null;
  }
  warOpen.current = open;

  /**
   * DER SCHLIESSEN-RUF LIEGT IN EINER REF, UND DAS IST DER GANZE PUNKT.
   *
   * Vorher stand `onSchliessen` in der Abhängigkeitsliste des Effekts. Fast
   * alle Aufrufer übergeben dort eine Pfeilfunktion oder eine im Rumpf
   * definierte Funktion — beides ist bei JEDEM Rendern eine neue Identität.
   * Also lief der Effekt nach jedem Tastendruck in einem Eingabefeld erneut:
   * Aufräumen (Fokus zurück auf das Element VOR dem Dialog), dann Neuaufbau
   * mit `focus()` auf das erste bedienbare Element — das Schließen-X.
   *
   * Sichtbar wurde es als „der Cursor springt nach jedem Buchstaben auf das X".
   * Betroffen war nicht ein Dialog, sondern jeder: 52 der 67 Aufrufstellen
   * übergeben eine Pfeilfunktion.
   *
   * Über die Ref bleibt der Effekt an `offen` und `titelId` gebunden — er läuft
   * beim Öffnen und beim Schliessen, sonst nie —, und der Tastatur-Handler
   * ruft trotzdem immer die AKTUELLE Funktion.
   */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    dialogStack.push(titleId);
    const panel = panelRef.current;

    // Fokus NICHT stehlen, wenn im Dialog schon etwas fokussiert ist. React
    // wertet `autoFocus` im Commit aus, also VOR diesem Effekt — ohne diese
    // Prüfung überschriebe der Griff nach dem ersten Element das gewünschte
    // Feld mit dem Schließen-X. Genau deshalb landete der Cursor auch beim
    // Öffnen nie im ersten Eingabefeld.
    if (!panel?.contains(document.activeElement)) {
      panel
        ?.querySelector<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        )
        ?.focus();
    }

    function onKey(e: KeyboardEvent) {
      // Nur das oberste Modal reagiert auf Tastatur.
      if (dialogStack[dialogStack.length - 1] !== titleId) return;
      if (e.key === 'Escape') {
        closeRef.current();
        return;
      }
      if (e.key === 'Tab' && panel) {
        const focusable = panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const i = dialogStack.lastIndexOf(titleId);
      if (i >= 0) dialogStack.splice(i, 1);
      // Nur zurückgeben, wenn der Auslöser noch da ist (z. B. nicht mit einem
      // Drawer verschwunden) — sonst fiele der Fokus ins Leere.
      const target = beforeFocus.current;
      if (target?.isConnected) target.focus();
    };
  }, [open, titleId]);

  if (!open) return null;

  const ownOrHead = ownHead || !!head;

  return (
    // Statisches, unscharfes Overlay, das seinen Inhalt scrollt: passt das Modal
    // nicht ins Bild, wächst es nach unten und das Overlay (nicht das Modal)
    // bekommt den Scrollbalken – der unscharfe Hintergrund bleibt dabei statisch.
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/40 backdrop-blur-[3px]"
      onClick={onClose}
    >
      <div className="flex min-h-full items-center justify-center p-4">
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={ownOrHead ? undefined : titleId}
          aria-label={ownHead ? 'Vorschlag-Detail' : head ? title : undefined}
          className={`relative w-full rounded-xl border border-rahmen bg-flaeche shadow-dialog ${
            ownHead ? 'overflow-hidden border-t-4 border-t-vorschlag-rahmen' : 'p-6'
          } ${SIZE_CLASS[size]}`}
          onClick={(e) => e.stopPropagation()}
        >
          {ownHead ? (
            <button
              onClick={onClose}
              aria-label={uiT('dialog.close')}
              className="absolute right-4 top-4 z-10 rounded-lg border border-rahmen bg-flaeche p-1.5 text-leise hover:bg-flaeche-3"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          ) : (
            <div className="mb-3 flex items-start justify-between gap-4">
              <div className="min-w-0">
                {head ?? (
                  <>
                    {eyebrow && (
                      <p className="mb-0.5 text-xs font-semibold uppercase tracking-wide text-leise">
                        {eyebrow}
                      </p>
                    )}
                    <h2
                      id={titleId}
                      className={
                        eyebrow
                          ? 'text-2xl font-semibold text-text'
                          : 'text-lg font-semibold text-text'
                      }
                    >
                      {title}
                    </h2>
                  </>
                )}
              </div>
              <button
                onClick={onClose}
                aria-label={uiT('dialog.close')}
                className="shrink-0 rounded-md p-1 text-leise hover:bg-flaeche-3"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
          )}
          <div className={ownHead ? '' : 'text-sm text-text'}>{children}</div>
          {footer && (
            <div className="-mx-6 -mb-6 mt-6 flex justify-end gap-3 rounded-b-xl border-t border-rahmen bg-flaeche-2 px-6 py-4">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
