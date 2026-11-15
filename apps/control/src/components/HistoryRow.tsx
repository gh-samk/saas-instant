import { useState } from 'react';
import { History, StickyNote } from 'lucide-react';
import { Button } from '@saas-instant/ui';
import { errorText } from '../lib/api-client';
import { updateNote, type HistoryEntry } from '../lib/api';
import { TEXT_BUTTON } from '../lib/styles';
import { formatDate } from '../utils/date';
import { useT } from '../i18n';

/**
 * Eine Zeile des gemeinsamen Verlaufs.
 *
 * ZWEI STUFEN, NICHT DREI: Handgeschrieben (betont, `text-text`, eigenes
 * Icon auf grüner Softfläche) gegen automatisch (gedämpft, `text-leise`,
 * neutrales Icon). Statuswechsel, Wechsel der Ansprechpartnerin und
 * Formularanfragen sind alle „nicht von Hand geschrieben" und bekommen
 * dieselbe Behandlung — drei unterschiedlich gewichtete Stufen hätten die
 * Liste unruhig gemacht, ohne mehr zu sagen.
 *
 * Die Unterscheidung hängt nie an der Farbe allein: Das Icon unterscheidet
 * sich mit.
 *
 * Systemerzeugte Einträge tragen keinen Bearbeiten-Weg. Sie sind der
 * Nachweis, kein Kommentarfeld — der Server weist eine Änderung mit
 * `409 notiz_vom_system` ab, und die Oberfläche bietet sie gar nicht erst an.
 */
export function HistoryRow({
  entry,
  onChanged,
}: {
  entry: HistoryEntry;
  onChanged: (entry: HistoryEntry) => void;
}) {
  const t = useT();
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(entry.text);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handwritten = !entry.bySystem;
  const Icon = handwritten ? StickyNote : History;
  const circle = handwritten
    ? 'bg-primaer-soft text-primaer'
    : 'bg-flaeche-3 text-leise';

  function cancel() {
    setText(entry.text);
    setError(null);
    setEdit(false);
  }

  async function save() {
    if (text.trim() === '') {
      setError(t('components.historyRow.text'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const changed = await updateNote(entry.id, text.trim());
      onChanged(changed);
      setEdit(false);
    } catch (f) {
      setError(errorText(f, t('components.historyRow.text2')));
    } finally {
      setLoading(false);
    }
  }

  return (
    <li className="flex items-start gap-3 py-3">
      <span
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${circle}`}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>

      <div className="min-w-0 flex-1">
        {edit ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            noValidate
          >
            <label htmlFor={`notiz-${entry.id}`} className="sr-only">
              {t('components.historyRow.label')}</label>
            <textarea
              id={`notiz-${entry.id}`}
              rows={3}
              value={text}
              disabled={loading}
              onChange={(e) => setText(e.target.value)}
              className="w-full rounded-lg border border-rahmen bg-flaeche px-3 py-2 text-sm text-text placeholder:text-leise focus:border-primaer focus:outline-none disabled:opacity-70"
            />
            {error && (
              <p role="alert" className="mt-1 text-sm text-gefahr">
                {error}
              </p>
            )}
            <div className="mt-2 flex flex-wrap justify-end gap-2">
              <Button
                variant="ghost"
                type="button"
                onClick={cancel}
                disabled={loading}
              >
                {t('components.historyRow.button')}</Button>
              <Button type="submit" loading={loading}>
                {t('components.historyRow.button2')}</Button>
            </div>
          </form>
        ) : (
          <>
            <p
              className={`whitespace-pre-line break-words text-sm ${handwritten ? 'text-text' : 'text-leise'}`}
            >
              {entry.text}
            </p>
            {handwritten && (
              <button
                type="button"
                onClick={() => setEdit(true)}
                className={`mt-1 text-xs ${TEXT_BUTTON}`}
              >
                {t('components.historyRow.button3')}</button>
            )}
          </>
        )}
      </div>

      <span className="ziffern-tabellarisch shrink-0 text-xs text-leise">
        {formatDate(entry.date)}
      </span>
    </li>
  );
}
