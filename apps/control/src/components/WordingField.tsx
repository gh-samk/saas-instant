import { Bold, Italic, Underline } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { t, useT } from '../i18n';

/**
 * Das Redaktionsfeld für den Wortlaut einer Rundmail — mit Fett, Kursiv,
 * Unterstrichen und Absätzen.
 *
 * WARUM ES DIESES FELD ÜBERHAUPT GIBT. Der Rahmen der Mail ist HTML und steht
 * fest: Kopf, Fusszeile, Schrift, Farben, Abmeldelink. Veränderbar ist allein
 * der Rumpf, und dafür reicht ein Textfeld nicht — ein hervorgehobener Satz
 * oder ein Absatz ist Teil dessen, was eine Rundmail sagt.
 *
 * WARUM NUR DREI AUSZEICHNUNGEN. Der Säuberer des Servers lässt genau
 * `p`, `br`, `strong`, `em` und `u` durch; alles andere fällt still weg. Eine
 * Werkzeugleiste mit Überschriften, Farben oder Listen böte also Knöpfe an,
 * deren Wirkung beim Versand verschwände. Was hier steht, ist genau das, was
 * ankommt.
 *
 * WER DIE WAHRHEIT SAGT, IST DER SERVER. Dieses Feld schickt HTML; der Server
 * säubert es und LEITET DEN TEXTTEIL SELBST AB. Die hier abgeleitete Fassung
 * dient nur der Anzeige (Längenprüfung, Platzhalterhinweis) — zwei unabhängig
 * gelieferte Fassungen liefen auseinander, und wer die Vorschau liest, sähe
 * etwas anderes als Postfächer ohne HTML anzeigen.
 */

interface Props {
  id: string;
  label: string;
  /** Der formatierte Rumpf. Leerer String heisst: noch nichts geschrieben. */
  html: string;
  /** Liefert HTML und die daraus abgeleitete Textfassung. */
  onChange: (value: { html: string; text: string }) => void;
  helperText?: string;
  height?: string;
}

/** Die drei Auszeichnungen. `execCommand`-Name, Beschriftung, Symbol. */
const TOOLS = [
  { command: 'bold', label: t('components.wordingField.label'), abbreviation: t('components.wordingField.abbreviation'), Symbol: Bold },
  { command: 'italic', label: t('components.wordingField.label2'), abbreviation: t('components.wordingField.abbreviation2'), Symbol: Italic },
  {
    command: 'underline',
    label: t('components.wordingField.label3'),
    abbreviation: t('components.wordingField.abbreviation3'),
    Symbol: Underline,
  },
] as const;

export function WordingField({
  id,
  label,
  html,
  onChange,
  helperText,
  height = 'min-h-56',
}: Props) {
  const t = useT();
  const field = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<Record<string, boolean>>({});

  // NUR SETZEN, WENN ES WIRKLICH ABWEICHT. Bei jedem Tastendruck das
  // innerHTML neu zu schreiben, setzte den Cursor an den Anfang zurück — das
  // ist der klassische Fehler eines gesteuerten contentEditable.
  useEffect(() => {
    const node = field.current;
    if (node !== null && node.innerHTML !== html) {
      node.innerHTML = html;
    }
  }, [html]);

  function report(): void {
    const node = field.current;
    if (node === null) return;
    onChange({
      html: normalize(node.innerHTML),
      text: textFrom(node),
    });
  }

  function execute(command: string): void {
    field.current?.focus();
    // Veraltet, aber in jedem Browser vorhanden und für drei Auszeichnungen
    // der ehrlichere Weg als ein selbstgebauter Auswahl-Editor: Der hätte
    // deutlich mehr Fehlerfläche als der Nutzen dieser Leiste rechtfertigt.
    //
    // GEPRÜFT, OB ES SIE GIBT. „In jedem Browser vorhanden" ist eine Aussage
    // über heute; ein entfernter Befehl darf die Redaktion nicht abstürzen
    // lassen, während der getippte Wortlaut im Feld steht. Fehlt er, bleibt
    // die Auszeichnung aus — der Text ist dann unformatiert, aber da.
    if (typeof document.execCommand === 'function') {
      document.execCommand(command);
    }
    updateState();
    report();
  }

  function updateState(): void {
    const state: Record<string, boolean> = {};
    for (const tool of TOOLS) {
      try {
        state[tool.command] = document.queryCommandState(tool.command);
      } catch {
        // `queryCommandState` wirft, wenn die Auswahl ausserhalb liegt. Dann
        // ist schlicht nichts aktiv.
        state[tool.command] = false;
      }
    }
    setActive(state);
  }

  return (
    <div className="mb-4 text-left">
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-text">
        {label}
      </label>

      <div
        role="toolbar"
        aria-label={t('components.wordingField.ariaLabel', { label })}
        aria-controls={id}
        className="flex gap-1 rounded-t-lg border border-b-0 border-rahmen bg-flaeche-3 px-2 py-1.5"
      >
        {TOOLS.map(({ command, label, abbreviation, Symbol }) => (
          <button
            key={command}
            type="button"
            // `onMouseDown` statt `onClick`: Ein Klick nähme dem Feld zuerst
            // den Fokus, und mit ihm die Auswahl, auf die sich der Befehl
            // beziehen soll.
            onMouseDown={(ev) => {
              ev.preventDefault();
              execute(command);
            }}
            aria-pressed={active[command] === true}
            title={`${label} (${abbreviation})`}
            className={`rounded px-2 py-1 text-sm text-text hover:bg-flaeche ${
              active[command] === true ? 'bg-flaeche font-semibold' : ''
            }`}
          >
            <Symbol className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">{label}</span>
          </button>
        ))}
      </div>

      <div
        id={id}
        ref={field}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        onInput={report}
        onBlur={report}
        onKeyUp={updateState}
        onMouseUp={updateState}
        className={`${height} w-full overflow-y-auto rounded-b-lg border border-rahmen bg-flaeche px-3 py-2 text-sm text-text focus:border-primaer focus:outline-none [&_p]:mb-2`}
      />

      {helperText && <p className="mt-1 text-sm text-leise">{helperText}</p>}
    </div>
  );
}

/**
 * Bringt das Ergebnis von `execCommand` auf die fünf Tags, die der Server
 * durchlässt.
 *
 * Die Browser sind sich uneinig: Chrome schreibt `<b>` und `<i>`, `<div>` für
 * einen neuen Absatz. Der Säuberer verwirft alle drei — bei `<div>` mit der
 * unangenehmen Folge, dass der Absatzumbruch verschwindet und zwei Absätze im
 * Postfach zu einem werden. Deshalb wird hier übersetzt statt gehofft.
 *
 * Die Regeln greifen nur den Tag selbst, nie ein Attribut: `<b>` trifft
 * `<br>` nicht, weil das `>` Teil des Musters ist.
 */
export function normalize(raw: string): string {
  return raw
    .replace(/<b>/gi, '<strong>')
    .replace(/<\/b>/gi, '</strong>')
    .replace(/<i>/gi, '<em>')
    .replace(/<\/i>/gi, '</em>')
    .replace(/<div>/gi, '<p>')
    .replace(/<\/div>/gi, '</p>')
    .trim();
}

/**
 * Die Textfassung, wie sie ein Postfach ohne HTML zeigen würde.
 *
 * NUR FÜR DIE ANZEIGE. Was verschickt wird, leitet der Server selbst ab. Hier
 * braucht es sie für die Längengrenze und den Platzhalterhinweis — beides
 * soll beim Tippen stimmen und nicht erst beim Speichern.
 *
 * Bewusst über die Kindknoten statt über `innerText`: `innerText` hängt am
 * Layout, ist in jsdom nicht umgesetzt und damit im Test nicht prüfbar.
 */
export function textFrom(node: Node): string {
  let result = '';
  for (const kind of Array.from(node.childNodes)) {
    if (kind.nodeType === 3) {
      result += kind.textContent ?? '';
      continue;
    }
    if (!(kind instanceof Element)) continue;
    const tag = kind.tagName.toLowerCase();
    if (tag === 'br') {
      result += '\n';
      continue;
    }
    const inner = textFrom(kind);
    result += tag === 'p' || tag === 'div' ? `${inner}\n\n` : inner;
  }
  return result.replace(/\n{3,}/g, '\n\n').trim();
}
