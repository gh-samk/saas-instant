import { Children, type ReactNode } from 'react';
import { Pencil } from 'lucide-react';
import { Card, Button } from '@saas-instant/ui';
import { useT } from '../i18n';

interface Props {
  title: string;
  /**
   * Sprungmarke der Karte. Gebraucht von den Dashboard-Aufgaben: Der Server
   * kann in `handlung.ziel` nur eine Seite benennen, keinen Abschnitt darin.
   */
  id?: string;
  edit: boolean;
  /** Ist anderswo eine Karte offen? Dann bleibt der Stift hier gesperrt. */
  blocked?: boolean;
  loading?: boolean;
  error?: string | null;
  onEditStart: () => void;
  onSave: () => void;
  onCancel: () => void;
  /** Ansichtsmodus — typischerweise ein <dl>-Raster. */
  children: ReactNode;
  /** Bearbeitungsmodus — nur gerendert, wenn `bearbeiten` gilt. */
  form?: ReactNode;
}

/**
 * Eine Karte der Detailseite, die zwischen Ansehen und Bearbeiten umschaltet.
 *
 * Der Grund für diesen Baustein: Ein einziges Formular mit dreißig Feldern ist
 * unbrauchbar. Stattdessen gibt es vier kleine, nach Sinnzusammenhang
 * gruppierte Formulare, die unabhängig voneinander gespeichert werden — wer
 * nur die Telefonnummer der Stellvertretung nachträgt, öffnet eine Karte,
 * nicht die ganze Seite.
 *
 * Immer nur EINE Karte ist zugleich offen. Statt einer Rückfrage („Änderungen
 * verwerfen?") sind die Stifte aller anderen Karten währenddessen gesperrt:
 * klar, ohne Dialog, ohne die Möglichkeit, Eingetipptes zu verlieren.
 *
 * Die Fußleiste liegt INNERHALB der `Karte` und zieht sich über deren
 * Innenabstand hinaus (`-mx-6 -mb-6`) — dasselbe Rezept, mit dem `Dialog`
 * seine Fußleiste anlegt. Außerhalb der Karte platziert (wie im Entwurf
 * skizziert) müsste sie den Kartenrand von außen nachbauen und liefe bei 375 px
 * leicht aus ihm heraus.
 */
export function DetailBlock({
  title,
  id,
  edit,
  blocked = false,
  loading = false,
  error = null,
  onEditStart,
  onSave,
  onCancel,
  children,
  form,
}: Props) {
  const t = useT();
  return (
    <Card className="mt-6 p-6" id={id}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-text">{title}</h2>
        {!edit && (
          <button
            type="button"
            onClick={onEditStart}
            disabled={blocked}
            aria-label={t('components.detailBlock.editLabel', { title })}
            title={
              blocked
                ? t('components.detailBlock.title')
                : t('components.detailBlock.editLabel', { title })
            }
            className="grid h-11 w-11 shrink-0 sm:h-9 sm:w-9 place-items-center rounded-lg border border-rahmen text-leise transition-colors hover:bg-flaeche-3 hover:text-text disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
          >
            <Pencil className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>

      {edit ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave();
          }}
          noValidate
        >
          <fieldset disabled={loading} className="min-w-0 border-0 p-0">
            {form}
          </fieldset>
          {error && (
            <p role="alert" className="mt-3 text-sm text-gefahr">
              {error}
            </p>
          )}
          <div className="-mx-6 -mb-6 mt-6 flex flex-wrap justify-end gap-3 rounded-b-xl border-t border-rahmen bg-flaeche-2 px-6 py-4">
            <Button variant="ghost" type="button" onClick={onCancel} disabled={loading}>
              {t('components.detailBlock.button')}</Button>
            <Button type="submit" loading={loading}>
              {t('components.detailBlock.button2')}</Button>
          </div>
        </form>
      ) : (
        children
      )}
    </Card>
  );
}

/**
 * Ein Feld im Ansichtsmodus.
 *
 * Leere Werte zeigen „—", nie eine leere Zeile. Mit `onAdd` wird aus dem
 * Strich stattdessen die Einladung „+ Website hinzufügen": Ein leeres
 * OPTIONALES Feld ist kein Befund, sondern etwas, das man nachtragen kann —
 * und der Klick öffnet die Bearbeitung des Blocks. Ist `onAdd` nicht gesetzt
 * (etwa, weil anderswo schon ein Block offen ist), bleibt es beim Strich.
 */
export function Field({
  label,
  children,
  wide = false,
  onAdd,
}: {
  label: string;
  children?: ReactNode;
  wide?: boolean;
  onAdd?: () => void;
}) {
  const t = useT();
  // `toArray` lässt null, undefined und Wahrheitswerte weg: Auch ein Feld,
  // dessen Ausdrücke alle „nichts" ergeben, gilt als leer.
  const empty = Children.toArray(children).every((child) => child === '');
  return (
    <div className={`min-w-0 ${wide ? 'sm:col-span-2' : ''}`}>
      <dt className="text-xs font-semibold uppercase tracking-wide text-leise">
        {label}
      </dt>
      <dd className="mt-0.5 break-words text-sm text-text">
        {empty ? (
          onAdd ? (
            <button
              type="button"
              onClick={onAdd}
              className="inline-flex min-h-11 items-center text-left text-primaer underline-offset-2 hover:text-primaer-hover hover:underline sm:min-h-0"
            >
              {t('components.detailBlock.addField', { label })}
            </button>
          ) : (
            <span className="text-leise">—</span>
          )
        ) : (
          children
        )}
      </dd>
    </div>
  );
}
