import { useState } from 'react';
import { Info, MailCheck } from 'lucide-react';
import { Card, Button } from '@saas-instant/ui';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';
import { errorText } from '../lib/api-client';
import { useSecondFactorEvidence } from '../lib/second-factor';
import {
  sendTestSend,
  type TestSendResult,
  type SecondFactorEvidence,
} from '../lib/api';
import { t, useT } from '../i18n';

/**
 * Was ein misslungener Testversand bedeutet — in Worten statt im Rohwert.
 *
 * `versendeEine` gibt bei Misserfolg einen von vier Zuständen zurück; sie
 * unbearbeitet anzuzeigen hiesse, an dieser Stelle „abgewiesen" hinzuschreiben
 * und die Erklärung dem Leser zu überlassen.
 */
const REASON_TEXTS: Record<string, string> = {
  rejected:
    t('components.broadcastTestSendCard.refused'),
  retry:
    t('components.broadcastTestSendCard.repeat'),
  failed:
    t('components.broadcastTestSendCard.failed'),
  nothing:
    t('components.broadcastTestSendCard.nothing'),
};

/**
 * ===========================================================================
 * TESTVERSAND — an die eigene Adresse, und an keine andere
 * ===========================================================================
 *
 * ES GIBT HIER KEIN ADRESSFELD, und das ist die wichtigste Eigenschaft dieser
 * Karte. Der Server hat auch keines: `POST /vorlagen/:id/testversand` nimmt
 * ausschliesslich die Adresse des angemeldeten Kontos, und für sie gilt
 * dieselbe Prüfung wie für jeden anderen Empfänger.
 *
 * WARUM — denn es sieht nach einer Schikane aus: Ein Testversand an eine frei
 * wählbare Adresse ist genau der Weg, auf dem sich R3 „durch Fehlbedienung"
 * umgehen liesse. Erst an die eigene Adresse, dann „schnell mal" an die der
 * Interessentin, die noch nicht bestätigt hat — und schon ist die Regel, die
 * das ganze Modul trägt, über einen Testknopf ausgehebelt.
 *
 * EIN FELD ANZUBIETEN, DAS ES NICHT GIBT, WÄRE DER SCHLIMMERE WEG. Die Karte
 * schreibt deshalb hin, an welche Adresse die Mail geht und warum es keine
 * Auswahl gibt, statt die Auslassung stillschweigend zu lassen.
 *
 * FÜR DIE EIGENE ADRESSE BRAUCHT ES EBENFALLS EINE BESTÄTIGTE EINWILLIGUNG.
 * Wer testen will, trägt sie einmal über das öffentliche Anmeldeformular ein
 * und klickt den Link im Postfach — dabei wird zugleich der Bestätigungsweg
 * selbst geprüft. Das ist kein Umweg, sondern der einzige ehrliche Test.
 */
export function BroadcastTestSendCard({
  templateId,
  ownAddress,
  totpPossible,
  className,
}: {
  templateId: string;
  /** Die Adresse des angemeldeten Kontos. Es gibt keine andere Wahl. */
  ownAddress: string;
  totpPossible: boolean;
  className?: string;
}) {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TestSendResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const evidenceState = useSecondFactorEvidence();

  async function test(evidence?: SecondFactorEvidence) {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const response = await sendTestSend(templateId, evidence);
      evidenceState.close();
      setResult(response);
    } catch (f) {
      if (evidenceState.handle(f, evidence)) return;
      setError(errorText(f, t('components.broadcastTestSendCard.text')));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className={`p-6 ${className ?? ''}`}>
      <h2 className="text-lg font-semibold text-text">
        {t('components.broadcastTestSendCard.heading')}</h2>
      <p className="mt-1 text-sm text-leise">
        {t('components.broadcastTestSendCard.text2')}{' '}
        <span className="break-all font-medium text-text">
          {ownAddress === '' ? t('components.broadcastTestSendCard.label') : ownAddress}
        </span>{' '}
        {t('components.broadcastTestSendCard.text3')}</p>

      <div className="mt-3 flex items-start gap-3 rounded-lg border border-rahmen bg-flaeche-2 p-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-leise" aria-hidden="true" />
        <div className="min-w-0 text-sm text-leise">
          <p className="font-semibold text-text">
            {t('components.broadcastTestSendCard.text4')}</p>
          <p className="mt-1">
            {t('components.broadcastTestSendCard.text5')}</p>
          <p className="mt-1">
            {t('components.broadcastTestSendCard.text6')}</p>
        </div>
      </div>

      <Button
        variant="secondary"
        className="mt-4"
        loading={loading}
        onClick={() => void test()}
      >
        <MailCheck className="h-4 w-4" aria-hidden="true" />
        {t('components.broadcastTestSendCard.button')}</Button>

      <div aria-live="polite">
        {result !== null &&
          (result.sent ? (
            <p className="mt-3 text-sm text-text">
              {t('components.broadcastTestSendCard.text7')}</p>
          ) : (
            <p className="mt-3 text-sm text-text">
              {result.reason !== undefined
                ? (REASON_TEXTS[result.reason] ??
                  t('components.broadcastTestSendCard.text8', { reason: result.reason }))
                : t('components.broadcastTestSendCard.text9')}
            </p>
          ))}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-gefahr">
          {error}
        </p>
      )}

      <SecondFactorEvidenceDialog
        open={evidenceState.open}
        title={t('components.broadcastTestSendCard.title')}
        declaration={t('components.broadcastTestSendCard.declaration')}
        totpPossible={totpPossible}
        loading={loading}
        error={evidenceState.error}
        onCancel={evidenceState.close}
        onConfirm={(evidence) => void test(evidence)}
      />
    </Card>
  );
}
