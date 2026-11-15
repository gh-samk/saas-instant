import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Clock3,
  History as HistoryIcon,
} from 'lucide-react';
import { Card } from '@saas-instant/ui';
import {
  fetchInvoiceHistory,
  fetchInvoiceIntegrity,
  type IntegrityResult,
  type InvoiceHistoryEntry,
} from '../lib/api';
import { formatDate } from '../utils/date';
import { useT, type TFunction } from '../i18n';

/** Aus dem Audit-Log-Aktionsnamen die Beschriftung der Zeitleiste. */
const ACTION_KEY: Record<string, string> = {
  'invoice.draft.created': 'gobd.historyCreated',
  'invoice.draft.updated': 'gobd.historyDraftChanged',
  'invoice.finalized': 'gobd.historyFinalized',
  'invoice.document.generated': 'gobd.historyDocumentGenerated',
  'invoice.document.invalid': 'gobd.historyDocumentInvalid',
  'invoice.sent': 'gobd.historySent',
  'invoice.send.failed': 'gobd.historySendFailed',
  'invoice.payment_reminder': 'gobd.historyReminder',
  'invoice.cancelled': 'gobd.historyCancelled',
  'invoice.payment.noted': 'gobd.historyPaid',
  'invoice.transfer.noted': 'gobd.historyTransfer',
  'invoice.integrity_failed': 'gobd.historyIntegrityFailed',
};

const CHECK_KEY: Record<string, string> = {
  pdf_sha256: 'gobd.checkPdf',
  xml_sha256: 'gobd.checkXml',
  xrechnung_sha256: 'gobd.checkXrechnung',
  number_sequence: 'gobd.checkNumberSequence',
};

/** `2026-11-15T09:30:00.000Z` -> `15.11.2026 09:30` (UTC, wie gespeichert). */
function utcStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const [day, time] = date.toISOString().split('T');
  const [y, m, d] = (day ?? '').split('-');
  return `${d}.${m}.${y} ${(time ?? '').slice(0, 5)}`;
}

/**
 * Integrität, Aufbewahrung und Verlauf EINER festgeschriebenen Rechnung (GoBD).
 *
 * Alles rein lesend. Das Abzeichen trägt Icon UND Text — Farbe allein sagt
 * nichts. Eine Abweichung ist ein `alert`, damit sie nicht überlesen wird.
 */
export function InvoiceIntegrity({
  invoiceId,
  finalized,
  retentionUntil,
}: {
  invoiceId: string;
  finalized: boolean;
  retentionUntil?: string | null;
}) {
  const t = useT();
  const [integrity, setIntegrity] = useState<IntegrityResult | null>(null);
  const [integrityError, setIntegrityError] = useState(false);
  const [history, setHistory] = useState<InvoiceHistoryEntry[] | null>(null);
  const [historyError, setHistoryError] = useState(false);

  useEffect(() => {
    let lives = true;
    setIntegrity(null);
    setIntegrityError(false);
    if (finalized) {
      fetchInvoiceIntegrity(invoiceId)
        .then((r) => {
          if (!lives) return;
          if (r && Array.isArray(r.checks)) setIntegrity(r);
          else setIntegrityError(true);
        })
        .catch(() => lives && setIntegrityError(true));
    }
    setHistory(null);
    setHistoryError(false);
    fetchInvoiceHistory(invoiceId)
      .then((r) => {
        if (!lives) return;
        if (Array.isArray(r)) setHistory(r);
        else setHistoryError(true);
      })
      .catch(() => lives && setHistoryError(true));
    return () => {
      lives = false;
    };
  }, [invoiceId, finalized]);

  return (
    <Card className="mt-6 p-6">
      <h2 className="mb-4 text-lg font-semibold text-text">
        {t('gobd.integrityTitle')}
      </h2>

      {finalized && (
        <div className="mb-4" aria-live="polite">
          {integrityError ? (
            <p role="alert" className="text-sm text-leise">
              {t('gobd.integrityFailed')}
            </p>
          ) : integrity === null ? (
            <p className="text-sm text-leise">{t('gobd.integrityLoading')}</p>
          ) : (
            <IntegrityBadge result={integrity} />
          )}
        </div>
      )}

      <p className="flex items-start gap-2 text-sm text-text">
        <Archive
          className="mt-0.5 h-4 w-4 shrink-0 text-leise"
          aria-hidden="true"
        />
        <span>
          {retentionUntil
            ? t('gobd.retention', { date: formatDate(retentionUntil) })
            : t('gobd.retentionNone')}
        </span>
      </p>
      <p className="mt-1 text-xs text-leise">{t('gobd.retentionNote')}</p>

      <h3 className="mb-3 mt-6 flex items-center gap-2 text-base font-semibold text-text">
        <HistoryIcon className="h-4 w-4 text-leise" aria-hidden="true" />
        {t('gobd.historyTitle')}
      </h3>
      {historyError ? (
        <p role="alert" className="text-sm text-leise">
          {t('gobd.historyFailed')}
        </p>
      ) : history === null ? (
        <p className="text-sm text-leise">{t('gobd.historyLoading')}</p>
      ) : history.length === 0 ? (
        <p className="text-sm text-leise">{t('gobd.historyEmpty')}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {history.map((entry, index) => (
            <li key={`${entry.at}-${index}`} className="flex items-start gap-3">
              <Clock3
                className="mt-0.5 h-4 w-4 shrink-0 text-leise"
                aria-hidden="true"
              />
              <div className="min-w-0 text-sm">
                <p className="font-medium text-text">{actionLabel(entry, t)}</p>
                <p className="ziffern-tabellarisch text-leise">
                  {t('gobd.historyAt', { at: utcStamp(entry.at) })} ·{' '}
                  {t('gobd.historyBy', { actor: entry.actor })}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function actionLabel(
  entry: InvoiceHistoryEntry,
  t: TFunction,
): string {
  if (entry.action === 'invoice.document_downloaded') {
    return entry.format
      ? t('gobd.historyDocumentDownloadedFormat', {
          format: entry.format.toUpperCase(),
        })
      : t('gobd.historyDocumentDownloaded');
  }
  const key = ACTION_KEY[entry.action];
  return key ? t(key) : t('gobd.historyOther', { action: entry.action });
}

function IntegrityBadge({ result }: { result: IntegrityResult }) {
  const t = useT();
  if (!result.finalized) {
    return <p className="text-sm text-leise">{t('gobd.integrityDraft')}</p>;
  }
  const ok = result.ok;
  const Icon = ok ? CheckCircle2 : AlertTriangle;
  const surface = ok
    ? 'bg-beschluss-bg border-beschluss-rahmen text-beschluss-text'
    : 'bg-bedenken-bg border-bedenken-rahmen text-bedenken-text';
  return (
    <div>
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${surface}`}
        role={ok ? 'status' : 'alert'}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {ok ? t('gobd.integrityOk') : t('gobd.integrityMismatch')}
      </span>
      <p className="mt-2 text-sm text-leise">
        {ok ? t('gobd.integrityOkHint') : t('gobd.integrityMismatchHint')}
      </p>
      {!ok && (
        <ul className="mt-2 list-disc pl-5 text-sm text-text">
          {result.checks
            .filter((c) => !c.ok)
            .map((c) => (
              <li key={c.check}>
                {t(CHECK_KEY[c.check] ?? 'gobd.checkOther')}:{' '}
                {c.status === 'absent'
                  ? t('gobd.checkAbsent')
                  : t('gobd.checkDeviation')}
              </li>
            ))}
        </ul>
      )}
      <p className="ziffern-tabellarisch mt-2 text-xs text-leise">
        {t('gobd.integrityCheckedAt', { at: utcStamp(result.checkedAt) })}
      </p>
    </div>
  );
}
