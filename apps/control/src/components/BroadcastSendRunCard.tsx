import { useState } from 'react';
import { Play } from 'lucide-react';
import { Card, Button, Spinner } from '@saas-instant/ui';
import { BroadcastProgress } from './BroadcastProgress';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';
import { errorText } from '../lib/api-client';
import { useSecondFactorEvidence } from '../lib/second-factor';
import {
  startSendRun,
  type SendRunResult,
  type SecondFactorEvidence,
} from '../lib/api';
import { t, useT } from '../i18n';

/** Die sechs Zahlen eines Laufs, jede mit dem Satz, was sie bedeutet. */
const NUMBERS: {
  key: keyof SendRunResult;
  label: string;
  declaration: string;
}[] = [
  {
    key: 'considered',
    label: t('components.broadcastSendRunCard.label'),
    declaration: t('components.broadcastSendRunCard.declaration'),
  },
  {
    key: 'sent',
    label: t('components.broadcastSendRunCard.label2'),
    declaration: t('components.broadcastSendRunCard.declaration2'),
  },
  {
    key: 'refused',
    label: t('components.broadcastSendRunCard.label3'),
    declaration:
      t('components.broadcastSendRunCard.declaration3'),
  },
  {
    key: 'repeat',
    label: t('components.broadcastSendRunCard.label4'),
    declaration:
      t('components.broadcastSendRunCard.declaration4'),
  },
  {
    key: 'failed',
    label: t('components.broadcastSendRunCard.label5'),
    declaration:
      t('components.broadcastSendRunCard.declaration5'),
  },
  {
    key: 'cleanedUp',
    label: t('components.broadcastSendRunCard.label6'),
    declaration:
      t('components.broadcastSendRunCard.declaration6'),
  },
];

/**
 * ===========================================================================
 * DER VERSANDLAUF — was man währenddessen sieht
 * ===========================================================================
 *
 * Zwei Schritte, die nicht zusammenfallen: EINSTELLEN legt die Zeilen an,
 * VERSENDEN arbeitet sie ab. Der Versandlauf läuft von selbst, jede Minute,
 * und nimmt dabei bis zu `CONTROL_RUNDMAIL_JE_LAUF` Zeilen auf — mit einigen
 * Sekunden Abstand zwischen zwei Mails.
 *
 * WARUM ES DEN KNOPF TROTZDEM GIBT: Ein Vorgang, der nur im Minutentakt eines
 * Cron stattfindet, lässt sich weder prüfen noch nachholen, wenn der Container
 * gerade neu gestartet ist. Dieselbe Begründung wie beim Zeitplan aus Etappe 2.
 *
 * DER AUFRUF DAUERT LANGE, und das muss dastehen. Bei den Vorgabewerten sind
 * es bis zu zwanzig Mails zu fünf Sekunden — anderthalb Minuten, in denen ein
 * gewöhnlicher Ladebalken wie ein Absturz aussieht. Der Hinweis sagt deshalb
 * ausdrücklich, was gerade geschieht und dass das Fenster offen bleiben darf.
 *
 * ES GIBT JETZT EINEN FORTSCHRITTSBALKEN, und er steht GANZ OBEN. Hier stand
 * lange das Gegenteil: keine Anzeige, weil es keine Warteschlangenabfrage gab
 * und ein Balken nach Schätzung eine erfundene Auskunft über einen
 * unumkehrbaren Vorgang gewesen wäre. Die Abfrage gibt es nun
 * (`GET /broadcast/vorlagen/:id/fortschritt`, reine Zählwerte ohne Adressen),
 * also bewegt sich der Balken nach gemessenen Zahlen — siehe
 * `RundmailFortschritt`.
 *
 * WARUM OBEN: Die Frage während eines Versands ist „wie weit ist meine
 * Rundmail", nicht „was hat der letzte Lauf getan". Das Laufergebnis darunter
 * beantwortet die zweite Frage und bleibt deshalb stehen.
 *
 * DIE SUMME ÜBER MEHRERE LÄUFE steht darunter. Ein einzelner Lauf schafft
 * höchstens zwanzig Zeilen; wer zweihundert eingestellt hat, drückt entweder
 * mehrmals oder wartet auf den Cron.
 */
export function BroadcastSendRunCard({
  templateId,
  trigger,
  totpPossible,
  className,
}: {
  templateId: string;
  /** Zählt hoch, sobald die Seite eine Rundmail eingestellt hat. */
  trigger: number;
  totpPossible: boolean;
  className?: string;
}) {
  const t = useT();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SendRunResult | null>(null);
  const [sentTotal, setSentTotal] = useState(0);
  const [runs, setRuns] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Ein beendeter Lauf ändert den Stand sofort — darauf zu warten, bis der
  // Takt das nächste Mal fragt, sähe aus, als wäre nichts passiert.
  const [afterRun, setAfterRun] = useState(0);
  const evidenceState = useSecondFactorEvidence();

  async function start(evidence?: SecondFactorEvidence) {
    setRunning(true);
    setError(null);
    try {
      const response = await startSendRun(evidence);
      evidenceState.close();
      setResult(response);
      setSentTotal((previous) => previous + (response?.sent ?? 0));
      setRuns((previous) => previous + 1);
      setAfterRun((previous) => previous + 1);
    } catch (f) {
      if (evidenceState.handle(f, evidence)) return;
      setError(errorText(f, t('components.broadcastSendRunCard.text')));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card className={`p-6 ${className ?? ''}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-text">{t('components.broadcastSendRunCard.heading')}</h2>
        <Button
          variant="secondary"
          loading={running}
          onClick={() => void start()}
        >
          <Play className="h-4 w-4" aria-hidden="true" />
          {t('components.broadcastSendRunCard.button')}</Button>
      </div>

      <p className="text-sm text-leise">
        {t('components.broadcastSendRunCard.text2')}</p>

      <BroadcastProgress
        templateId={templateId}
        trigger={trigger + afterRun}
      />

      {/* `aria-live`: Der Lauf dauert bis zu anderthalb Minuten. Ohne Ansage
          bleibt für Menschen mit Vorleseprogramm eine Minute lang Stille. */}
      <div aria-live="polite">
        {running && (
          <div className="mt-4 rounded-lg border border-rahmen bg-flaeche-2 p-3">
            <Spinner text={t('components.broadcastSendRunCard.text3')} />
            <p className="text-sm text-leise">
              {t('components.broadcastSendRunCard.text4')}</p>
          </div>
        )}

        {!running && result !== null && (
          <div className="mt-4">
            <p className="text-sm font-semibold text-text">
              {result.considered === 0
                ? t('components.broadcastSendRunCard.text5')
                : t('components.broadcastSendRunCard.text6', { sent: result.sent, considered: result.considered })}
            </p>
            <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {NUMBERS.map((number) => (
                <div key={number.key} className="min-w-0">
                  <dt className="text-xs text-leise">{number.label}</dt>
                  <dd className="ziffern-tabellarisch text-sm font-medium text-text">
                    {result[number.key]}
                  </dd>
                  <dd className="text-xs text-leise">{number.declaration}</dd>
                </div>
              ))}
            </dl>

            {runs > 1 && (
              <p className="ziffern-tabellarisch mt-3 text-sm text-leise">
                {t('components.broadcastSendRunCard.text7', { runs: runs, sentTotal: sentTotal })}
              </p>
            )}

            {result.sent > 0 && (
              <p className="mt-3 text-sm text-leise">
                {t('components.broadcastSendRunCard.text8')}</p>
            )}

            {result.repeat > 0 && (
              <p className="mt-3 text-sm text-leise">
                {t('components.broadcastSendRunCard.text9')}</p>
            )}

            {result.considered > 0 && (
              <p className="mt-3 text-sm text-leise">
                {t('components.broadcastSendRunCard.text10')}</p>
            )}
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-gefahr">
          {error}
        </p>
      )}

      <SecondFactorEvidenceDialog
        open={evidenceState.open}
        title={t('components.broadcastSendRunCard.title')}
        declaration={t('components.broadcastSendRunCard.declaration7')}
        totpPossible={totpPossible}
        loading={running}
        error={evidenceState.error}
        onCancel={evidenceState.close}
        onConfirm={(evidence) => void start(evidence)}
      />
    </Card>
  );
}
