import { useState } from 'react';
import { ExternalLink, FileSearch, RefreshCw } from 'lucide-react';
import { Button, NoticeBar, useToast } from '@saas-instant/ui';
import { errorText } from '../lib/api-client';
import { startReconciliation } from '../lib/api';
import type { ReconciliationState, OrphanedApplication } from '../lib/api';
import { instanceHost } from '../lib/instance-address';
import { formatDate } from '../utils/date';
import { useT } from '../i18n';

/**
 * Der Abgleich zwischen Coolify und dem CRM-Register — auf dem Dashboard.
 *
 * ER MELDET NUR (E3-16). Es gibt hier keine Handlung, die etwas zuordnet,
 * korrigiert oder löscht; die Karte ist eine Liste von Befunden mit dem
 * Hinweis, wo nachzusehen ist.
 *
 * ZWEI DINGE, DIE NICHT DASSELBE SIND, und deshalb getrennt stehen:
 *
 * 1. **Verwaiste Anwendungen** — eine Instanz in Coolify ohne CRM-Eintrag. Sie
 *    hat keine Organisation, an die sich eine `Aufgabe` hängen ließe; sie in
 *    die Aufgabentabelle zu zwingen, bräuchte ein erfundenes Platzhalter-Ziel.
 * 2. **Der Abgleich lief nicht durch.** Ein leerer Befund und ein
 *    ausgefallener Lauf sehen sonst gleich aus — die Oberfläche läse „keine
 *    Abweichungen", obwohl seit Tagen nichts gemessen wurde. Das ist die
 *    beruhigendste aller falschen Auskünfte, und der Server liefert
 *    `stand.abgleich` genau deswegen mit.
 *
 * Im Normalfall (Lauf erfolgreich, kein Befund) rendert die Karte NICHTS. Eine
 * dauerhafte Erfolgsmeldung „Kein Befund" bräuchte Platz für einen Zustand,
 * der der Normalfall sein soll — dasselbe Prinzip wie bei der Backup-Anzeige.
 */
export function ReconciliationCard({
  orphanedApplications,
  state,
  onRun,
}: {
  orphanedApplications: OrphanedApplication[];
  state: ReconciliationState;
  /** Nach einem Lauf die Seite neu laden — der Befund ist dann ein anderer. */
  onRun: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const hasFinding = orphanedApplications.length > 0;

  async function nowCheck() {
    setRunning(true);
    try {
      await startReconciliation();
      toast.show(t('components.reconciliationCard.text'));
      onRun();
    } catch (f) {
      toast.show(errorText(f, t('components.reconciliationCard.text2')));
    } finally {
      setRunning(false);
    }
  }

  if (!hasFinding && state.successful) return null;

  const checkButton = (
    <Button variant="secondary" className="w-full justify-center sm:w-auto" loading={running} onClick={() => void nowCheck()}>
      <RefreshCw className="h-4 w-4" aria-hidden="true" />
      {t('components.reconciliationCard.button')}
    </Button>
  );

  return (
    <section aria-labelledby="abgleich-titel" className="mt-6">
      {/* AUS DREI ZEILEN ERKLAERTEXT WIRD EINE ZEILE MIT ZUSTAND.
          Bis zum Redesign standen hier Ueberschrift und ein Absatz, der
          erklaerte, was ein Abgleich ist. Wer die Verwaltung taeglich
          benutzt, weiss das nach dem zweiten Mal; wichtig ist nur, WANN
          zuletzt gemessen wurde — das steht jetzt in der Zeile selbst. */}
      <h2 id="abgleich-titel" className="sr-only">
        {t('components.reconciliationCard.heading')}</h2>

      {/* EIN BAND MIT KNOPF DARIN. Der Knopf stand früher getrennt weit unten
          rechts; wer die Meldung liest, soll den Weg dazu direkt daneben
          finden. Im Fehlerfall steht er deshalb im Band, nicht darunter. */}
      {!state.successful && (
        <NoticeBar kind="attention" className="mb-3" action={checkButton}>
          {state.lastAt === null
            ? t('components.reconciliationCard.text3')
            : t('components.reconciliationCard.text4', { date: formatDate(state.lastAt) })}
          {state.message ? ` ${state.message}` : ''}
        </NoticeBar>
      )}

      {/* DER KNOPF STEHT IMMER, WENN DIESE KARTE UEBERHAUPT DA IST — im Band
          bei nicht gelaufenem Abgleich, sonst neben der Standzeile.
          
          DAS WAR DIE LUECKE: Wer etwas an der Zuordnung geaendert hatte —
          eine Instanz eingetragen, ein eigenes Deployment ausgeblendet —,
          hatte keinen Weg, das nachzumessen. Die Karte zeigte weiter den
          Befund von heute Nacht, und der naechste Lauf kam um 02:30. Genau
          in dem Zustand faengt man an, einer Liste nicht mehr zu glauben.

          ER HING ZUERST AN `hatBefund` und fehlte damit im Fall, in dem er am
          dringendsten gebraucht wird: Lauf gescheitert, Befund leer. Dann
          steht dort „kam nicht durch" — und kein Weg, es noch einmal zu
          versuchen. Die Karte rendert ohnehin nur in diesen beiden Fällen;
          der Knopf gehört in beide.

          Die Standzeile dagegen NUR OHNE Fehlerleiste: Dort steht das Datum
          des letzten Laufs schon, und zweimal dasselbe in zwei Zeilen liest
          sich wie zwei verschiedene Angaben. */}
      {state.successful && (
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-leise">
            {t('components.reconciliationCard.text6')}{' '}
            <span className="ziffern-tabellarisch">
              {state.lastAt === null ? t('components.reconciliationCard.label') : formatDate(state.lastAt)}
            </span>
          </p>
          {checkButton}
        </div>
      )}

      {hasFinding && (
        <ul className="divide-y divide-rahmen overflow-hidden rounded-xl border border-rahmen bg-flaeche">
          {orphanedApplications.map((a) => (
            <li key={a.subdomain} className="flex items-start gap-3 p-4">
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-bedenken-bg text-bedenken-text">
                <FileSearch className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                {/* Bei 375 px rutscht die Zeitangabe unter die Adresse, statt
                    ihr die halbe Zeilenbreite wegzunehmen. */}
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <p className="min-w-0 break-words text-sm font-medium text-text">
                    {instanceHost(a.subdomain)}
                  </p>
                  <span className="shrink-0 whitespace-nowrap text-xs text-leise">
                    {t('components.reconciliationCard.label2')}{' '}
                    <span className="ziffern-tabellarisch">
                      {formatDate(a.detectedAt)}
                    </span>
                  </span>
                </div>
                <p className="text-sm text-leise">
                  {t('components.reconciliationCard.text7')}</p>
                {/* Der einzige angebotene Weg führt aus der Anwendung hinaus
                    und ist rein lesend. Nur echte https-Adressen werden
                    verlinkt: der Wert stammt aus einer JSON-Spalte. */}
                {a.coolifyUrl?.startsWith('https://') && (
                  <a
                    href={a.coolifyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-flex items-center gap-1 text-xs text-primaer underline underline-offset-2 hover:text-primaer-hover"
                  >
                    {t('components.reconciliationCard.text8')}<ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
