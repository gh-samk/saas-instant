import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileSearch, Info, Users } from 'lucide-react';
import { Card, Button, EmptyState, Skeleton, Table } from '@saas-instant/ui';
import { ConsentEvidenceDialog } from './ConsentEvidenceDialog';
import { errorText } from '../lib/api-client';
import { TEXT_BUTTON, TEXT_BUTTON_ACTION } from '../lib/styles';
import { fetchRecipients, type RecipientSelect } from '../lib/api';
import { formatDate } from '../utils/date';
import { t, useT } from '../i18n';

/** Wie viele Zeilen ohne Nachfrage stehen, bevor der Rest aufgeklappt wird. */
const FIRST_ROWS = 10;

/**
 * ===========================================================================
 * DIE EMPFÄNGERAUSWAHL — EINE VORHERSAGE, KEINE ZUSAGE
 * ===========================================================================
 *
 * Der Auftrag verlangt, dass VOR dem Absenden zu sehen ist, wer genau die Mail
 * bekommt und wie viele es sind. Diese Karte zeigt beides. Sie darf dabei aber
 * nicht behaupten, dass genau diese N Adressen die Mail bekommen — und das ist
 * der Punkt, an dem eine gut gemeinte Oberfläche eine Regel aufweicht, die das
 * Backend mit erheblichem Aufwand hält:
 *
 * DIE EINWILLIGUNG WIRD BEIM VERSAND GEPRÜFT, NICHT HIER. Der Versandlauf
 * nimmt jede Zeile einzeln auf, sperrt die Einwilligungszeile und entscheidet
 * unmittelbar vor dem SMTP-Aufruf neu. Wer zwischen dieser Anzeige und dem
 * Versand widerruft, bekommt nichts — und das ist richtig so, nicht ein
 * Fehler der Liste.
 *
 * DER HINWEISSATZ KOMMT VOM SERVER und wird angezeigt, nicht durch eine eigene
 * Formulierung ersetzt: Der Server ist die Stelle, die weiss, wann die Prüfung
 * wirklich stattfindet. Die Überschrift „Stand jetzt" und der Zusatz unter der
 * Zahl sagen dasselbe noch einmal in eigenen Worten — die Lücke zu verschweigen
 * wäre die bequemere und die falsche Lösung.
 *
 * ES GIBT HIER KEINE AUSWAHLKÄSTCHEN, und das ist Absicht. Eine Liste, in der
 * sich einzelne Adressen an- und abwählen liessen, hätte kein Gegenstück im
 * Backend: `POST /vorlagen/:id/versand` nimmt kein Empfängerfeld entgegen. Ein
 * Häkchen, das nichts bewirkt, ist schlimmer als keines.
 */
export function RecipientSelectCard({
  className,
  title = t('components.recipientSelectCard.text'),
  onLoaded,
  asTable = false,
  withoutMetric = false,
}: {
  className?: string;
  title?: string;
  /**
   * Zeilen als Tabelle statt als Liste — mit der Spalte „Quelle".
   *
   * Auf der Vorlagenseite bleibt die Liste: Dort ist sie eine Nebenangabe
   * neben dem Versand, und vier Spalten wären dort mehr Struktur als Inhalt.
   * Im Reiter „Einwilligungen" IST sie der Inhalt.
   */
  asTable?: boolean;
  /**
   * Zahl und Vorhersage-Hinweis weglassen, weil sie daneben in einer eigenen
   * Kachel stehen. Sie zweimal zu zeigen hiesse, zwei Zahlen zu haben, die
   * auseinanderlaufen können — hier kommen beide aus DERSELBEN Abfrage.
   */
  withoutMetric?: boolean;
  /**
   * Meldet die frisch geladene Auswahl nach oben — die Versandseite zeigt die
   * Zahl im Bestätigungsdialog noch einmal. Zwei Abfragen derselben Route
   * nebeneinander liefen sonst auseinander, und ausgerechnet die Zahl vor dem
   * unumkehrbaren Schritt wäre dann die ältere.
   */
  onLoaded?: (select: RecipientSelect) => void;
}) {
  const t = useT();
  const [select, setSelect] = useState<RecipientSelect | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [allShow, setAllShow] = useState(false);
  const [evidenceFor, setEvidenceFor] = useState<string | null>(null);

  const lives = useRef(true);
  useEffect(() => {
    lives.current = true;
    return () => {
      lives.current = false;
    };
  }, []);

  // DIE RÜCKRUFFUNKTION LIEGT IN EINER REF, NICHT IN DER ABHÄNGIGKEITSLISTE.
  // Aufrufer übergeben sie als Pfeilfunktion; die ist bei jedem Durchlauf eine
  // neue. Stünde sie in der Liste von `laden`, änderte sich `laden` bei jedem
  // Durchlauf, der Effekt liefe erneut, das Ergebnis setzte den Zustand, und
  // die Seite fragte die Empfängerliste in einer Endlosschleife ab.
  const message = useRef(onLoaded);
  useEffect(() => {
    message.current = onLoaded;
  }, [onLoaded]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await fetchRecipients();
      if (!lives.current) return;
      // Die Form der Antwort wird geprüft, nicht geglaubt: Ein `.map` auf
      // etwas, das keine Liste ist, risse sonst die ganze Seite mit. Sichtbar
      // als Fehler, nicht still als „niemand" — „niemand bekommt die Mail"
      // wäre hier die beruhigendste aller falschen Auskünfte.
      if (!Array.isArray(response?.recipient)) {
        setLoadError(t('components.recipientSelectCard.text2'));
        setSelect(null);
        return;
      }
      setSelect(response);
      message.current?.(response);
    } catch (f) {
      if (!lives.current) return;
      setLoadError(
        errorText(f, t('components.recipientSelectCard.text3')),
      );
      setSelect(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows =
    select === null
      ? []
      : allShow
        ? select.recipient
        : select.recipient.slice(0, FIRST_ROWS);
  const hidden =
    select === null ? 0 : select.recipient.length - rows.length;

  return (
    <Card className={`p-6 ${className ?? ''}`}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-text">{title}</h2>
        <Button variant="secondary" onClick={() => void load()}>
          {t('components.recipientSelectCard.button')}</Button>
      </div>

      {loadError ? (
        <p role="alert" className="mt-3 text-sm text-gefahr">
          {loadError}
        </p>
      ) : select === null ? (
        <div className="mt-3 flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : (
        <>
          {!withoutMetric && (
          <p className="ziffern-tabellarisch text-2xl font-bold text-text">
            {select.count}
          </p>
          )}
          <p className="text-sm text-leise">
            {select.count === 1
              ? t('components.recipientSelectCard.text4')
              : t('components.recipientSelectCard.text5')}
          </p>

          {/* Der Satz des Servers, im Wortlaut. Er ist die Stelle, die weiss,
              wann die Prüfung wirklich stattfindet. */}
          {!withoutMetric && (
          <div className="mt-3 flex items-start gap-3 rounded-lg border border-vorschlag-rahmen bg-vorschlag-bg p-3">
            <Info
              className="mt-0.5 h-4 w-4 shrink-0 text-vorschlag-text"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-vorschlag-text">
                {t('components.recipientSelectCard.text6')}</p>
              <p className="mt-1 text-sm text-vorschlag-text">
                {select.note}
              </p>
              <p className="mt-1 text-sm text-vorschlag-text">
                {t('components.recipientSelectCard.text7')}</p>
            </div>
          </div>
          )}

          {select.recipient.length === 0 ? (
            <EmptyState
              Icon={Users}
              title={t('components.recipientSelectCard.title')}
              notice={t('components.recipientSelectCard.notice')}
            />
          ) : (
            <>
              {asTable ? (
                <div className="mt-4 overflow-hidden rounded-xl border border-rahmen">
                  <Table
                    variant="list"
                    label={t('components.recipientSelectCard.label')}
                    columns={[
                      t('components.recipientSelectCard.columns'),
                      t('components.recipientSelectCard.columns2'),
                      t('components.recipientSelectCard.columns3'),
                      t('components.recipientSelectCard.columns4'),
                      t('components.recipientSelectCard.columns5'),
                    ]}
                    columnsWidths={[
                      'w-4/12',
                      'w-3/12',
                      'w-2/12',
                      'w-2/12',
                      'w-1/12',
                    ]}
                    actionColumn
                    minWidth="min-w-[760px]"
                  >
                    {rows.map((row) => (
                      <tr key={row.consentId}>
                        <td className="break-all px-3 py-2.5 text-sm font-medium text-text">
                          {row.email}
                        </td>
                        <td className="px-3 py-2.5 text-sm text-leise">
                          {row.companyName !== null &&
                          row.companyId !== null ? (
                            <Link
                              to={`/companies/${row.companyId}`}
                              className={TEXT_BUTTON}
                            >
                              {row.companyName}
                            </Link>
                          ) : (
                            t('components.recipientSelectCard.text8')
                          )}
                        </td>
                        {/* DIE QUELLE SAGT, WO DER TEXT STAND, dem zugestimmt
                            wurde — nicht den Text selbst. Der ist der
                            eigentliche Nachweis und steht hinter dem Knopf
                            rechts, weil er ein Absatz ist und keine Zelle. */}
                        <td className="px-3 py-2.5 text-sm text-leise">
                          {row.origin ?? '—'}
                        </td>
                        <td className="ziffern-tabellarisch px-3 py-2.5 text-sm text-leise">
                          {row.confirmedAt === null
                            ? '—'
                            : formatDate(row.confirmedAt)}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <button
                            type="button"
                            className={`text-sm ${TEXT_BUTTON_ACTION}`}
                            onClick={() => setEvidenceFor(row.email)}
                          >
                            {t('components.recipientSelectCard.button2')}<span className="sr-only"> {t('components.recipientSelectCard.label2')}{row.email}</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </Table>
                </div>
              ) : (
              <ul className="mt-4 divide-y divide-rahmen">
                {rows.map((row) => (
                  <li
                    key={row.consentId}
                    className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 first:pt-0"
                  >
                    <div className="min-w-0">
                      <p className="break-all text-sm font-medium text-text">
                        {row.email}
                      </p>
                      <p className="text-xs text-leise">
                        {row.companyName !== null &&
                        row.companyId !== null ? (
                          <Link
                            to={`/companies/${row.companyId}`}
                            className={TEXT_BUTTON}
                          >
                            {row.companyName}
                          </Link>
                        ) : (
                          t('components.recipientSelectCard.text9')
                        )}
                        {row.confirmedAt !== null && (
                          <>
                            {t('components.recipientSelectCard.text10')}
                            <span className="ziffern-tabellarisch">
                              {formatDate(row.confirmedAt)}
                            </span>
                          </>
                        )}
                      </p>
                    </div>
                    <button
                      type="button"
                      className={`text-sm ${TEXT_BUTTON_ACTION}`}
                      onClick={() => setEvidenceFor(row.email)}
                    >
                      <FileSearch className="h-4 w-4" aria-hidden="true" />
                      {t('components.recipientSelectCard.button2')}</button>
                  </li>
                ))}
              </ul>
              )}

              {hidden > 0 && (
                <button
                  type="button"
                  className={`text-sm ${TEXT_BUTTON_ACTION}`}
                  onClick={() => setAllShow(true)}
                >
                  {t('components.recipientSelectCard.button3', { length: select.recipient.length })}
                </button>
              )}
            </>
          )}
        </>
      )}

      <ConsentEvidenceDialog
        open={evidenceFor !== null}
        email={evidenceFor ?? ''}
        onClose={() => setEvidenceFor(null)}
      />
    </Card>
  );
}
