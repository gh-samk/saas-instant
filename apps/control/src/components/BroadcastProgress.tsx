import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@saas-instant/ui';
import { errorText } from '../lib/api-client';
import { fetchSendProgress, type SendProgress } from '../lib/api';
import { useT } from '../i18n';

/**
 * Wie oft nachgefragt wird, solange noch etwas offen ist.
 *
 * Fünf Sekunden sind der Abstand, den der Versandlauf ohnehin zwischen zwei
 * Mails lässt (`CONTROL_RUNDMAIL_ABSTAND_MS`, Vorgabe 5000). Öfter zu fragen
 * lieferte dieselbe Zahl noch einmal; seltener liesse den Balken ruckeln.
 */
export const INTERVAL_MS = 5_000;

/**
 * ===========================================================================
 * DER FORTSCHRITT EINER EINGESTELLTEN RUNDMAIL
 * ===========================================================================
 *
 * Vorher stand hier eine Zeitansage: „bei einer vollen Warteschlange dauert
 * ein Lauf bis zu anderthalb Minuten". Das war die ehrlichste Auskunft, die
 * möglich war, denn es gab keine Warteschlangenabfrage — und ein Balken nach
 * Schätzung wäre eine erfundene Angabe über einen Vorgang gewesen, der gerade
 * unumkehrbar Mails verschickt.
 *
 * JETZT GIBT ES DIE ABFRAGE, und deshalb gibt es den Balken. Er bewegt sich
 * nach GEMESSENEN Zahlen: `versendet` von `gesamt`, beides aus einer Zählung
 * über die Versandtabelle. Bei einem grösseren Verteiler ist das der
 * Unterschied zwischen Vertrauen und Bangen.
 *
 * ES WIRD NUR SO LANGE GEFRAGT, WIE ETWAS OFFEN IST. Ist `offen` auf null,
 * hört das Nachfragen von selbst auf: Ein Takt, der ewig weiterläuft, ist eine
 * Dauerlast auf einer Seite, die tagelang offen stehen kann.
 *
 * NACH EINEM FEHLER WIRD NICHT WEITERGEFRAGT. Ein Takt, der gegen einen
 * gestörten Server anrennt, macht die Störung schlimmer und die Meldung
 * unlesbar. Stattdessen steht der Fehler da, und daneben ein Knopf — dieselbe
 * Bauweise wie beim Laden der Vorlage.
 *
 * DIE ANSAGE KOMMT ERST AM ENDE. `aria-live` auf dem Balken hiesse, dass ein
 * Vorleseprogramm alle fünf Sekunden eine neue Zahl vorliest. Angesagt wird
 * deshalb nur der Übergang auf „nichts mehr offen".
 */
export function BroadcastProgress({
  templateId,
  trigger,
}: {
  templateId: string;
  /**
   * Zählt hoch, wenn etwas passiert ist, das den Stand ändert — eine Rundmail
   * eingestellt, ein Lauf beendet. Der Stand wird dann sofort neu geholt,
   * statt bis zum nächsten Takt zu warten.
   */
  trigger: number;
}) {
  const t = useT();
  const [state, setState] = useState<SendProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [again, setAgain] = useState(0);
  // Ob schon einmal etwas offen war. Ohne diese Merkung sagte die Seite
  // „fertig", bevor überhaupt etwas eingestellt wurde.
  const warOpen = useRef(false);

  useEffect(() => {
    let aborted = false;
    let clock: ReturnType<typeof setTimeout> | undefined;

    const read = async (): Promise<void> => {
      try {
        const newValue = await fetchSendProgress(templateId);
        if (aborted) return;
        if (newValue.open > 0) warOpen.current = true;
        setState(newValue);
        setError(null);
        if (newValue.open > 0) {
          clock = setTimeout(() => void read(), INTERVAL_MS);
        }
      } catch (f) {
        if (aborted) return;
        setError(errorText(f, t('components.broadcastProgress.text')));
      }
    };

    void read();
    return () => {
      aborted = true;
      if (clock !== undefined) clearTimeout(clock);
    };
  }, [templateId, trigger, again]);

  const retry = useCallback(() => setAgain((previous) => previous + 1), []);

  if (error !== null) {
    return (
      <div className="mt-4 rounded-lg border border-rahmen bg-flaeche-2 p-3">
        <p role="alert" className="text-sm text-gefahr">
          {error}
        </p>
        <p className="mt-1 text-sm text-leise">
          {t('components.broadcastProgress.text2')}</p>
        <Button variant="secondary" className="mt-3" onClick={retry}>
          {t('components.broadcastProgress.button')}</Button>
      </div>
    );
  }

  if (state === null) return null;

  if (state.total === 0) {
    return (
      <p className="mt-4 text-sm text-leise">
        {t('components.broadcastProgress.text3')}</p>
    );
  }

  const done =
    state.sent + state.failed + state.refused;
  const percent = Math.round((done / state.total) * 100);
  const announcement =
    t('components.broadcastProgress.announcement', { sent: state.sent, total: state.total }) +
    t('components.broadcastProgress.announcement2', { open: state.open });

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="text-sm font-medium text-text">{t('components.broadcastProgress.text4')}</p>
        <p className="ziffern-tabellarisch text-sm text-leise">{`${percent} %`}</p>
      </div>

      <div
        role="progressbar"
        aria-label={t('components.broadcastProgress.ariaLabel')}
        aria-valuemin={0}
        aria-valuemax={state.total}
        aria-valuenow={done}
        aria-valuetext={announcement}
        className="mt-1 h-2 w-full overflow-hidden rounded-full bg-flaeche-3"
      >
        {/* Der Balken misst ERLEDIGTES, nicht Versendetes: Eine abgewiesene
            oder endgültig gescheiterte Zeile kommt nicht wieder, und ein
            Balken, der bei 96 % stehen bliebe, sähe aus wie ein Hänger. Was
            davon tatsächlich hinausging, steht als Zahl daneben. */}
        <div
          className="h-full rounded-full bg-primaer transition-[width] duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        {[
          {
            label: t('components.broadcastProgress.label'),
            value: state.sent,
            notice: t('components.broadcastProgress.notice'),
          },
          {
            label: t('components.broadcastProgress.label2'),
            value: state.open,
            notice: t('components.broadcastProgress.notice2'),
          },
          {
            label: t('components.broadcastProgress.label3'),
            value: state.refused,
            notice: t('components.broadcastProgress.notice3'),
          },
          {
            label: t('components.broadcastProgress.label4'),
            value: state.failed,
            notice: t('components.broadcastProgress.notice4'),
          },
        ].map((number) => (
          <div key={number.label} className="min-w-0">
            <dt className="text-sm text-leise">{number.label}</dt>
            <dd className="ziffern-tabellarisch text-sm font-medium text-text">
              {number.value}
            </dd>
            <dd className="text-sm text-leise">{number.notice}</dd>
          </div>
        ))}
      </dl>

      {/* Nur der ABSCHLUSS wird angesagt — nicht jeder Takt. */}
      <div aria-live="polite">
        {state.open === 0 && warOpen.current && (
          <p className="mt-3 text-sm text-text">
            {t('components.broadcastProgress.text5', { announcement: announcement })}
          </p>
        )}
        {state.open > 0 && (
          <p className="mt-3 text-sm text-leise">
            {t('components.broadcastProgress.text6')}</p>
        )}
      </div>
    </div>
  );
}
