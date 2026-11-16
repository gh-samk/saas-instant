import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  ChevronRight,
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

/**
 * `2026-11-15T09:30:00.000Z` -> `15.11.2026 10:30` in LOKALER Zeit.
 *
 * Den Kalendertag liefert `formatDate` (lokal, geprüft); die Uhrzeit kommt aus
 * denselben lokalen Feldern. Unlesbare Eingaben bleiben unangetastet — es wird
 * nichts geraten.
 */
export function localStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${formatDate(iso)} ${hh}:${mm}`;
}

/** Was die Integritätsprüfung und der Verlauf einer Rechnung gerade sagen. */
export interface IntegrityState {
  finalized: boolean;
  integrity: IntegrityResult | null;
  integrityError: boolean;
  history: InvoiceHistoryEntry[] | null;
  historyError: boolean;
}

/**
 * Lädt Prüfergebnis und Verlauf EINMAL — damit die Kopfzeile (Abzeichen) und
 * die eingeklappte Karte (Details) dieselben Daten zeigen und nicht zweimal
 * fragen. `reloadKey` lädt neu, wenn sich an der Rechnung etwas ändert, das
 * im Verlauf steht (Versand, Zahlung, Vermerk).
 */
export function useInvoiceIntegrity(
  invoiceId: string,
  finalized: boolean,
  reloadKey?: string,
): IntegrityState {
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
  }, [invoiceId, finalized, reloadKey]);

  return { finalized, integrity, integrityError, history, historyError };
}

/** Ist das Ergebnis ein Fehlerzustand (Abweichung oder Prüfung nicht möglich)? */
function isProblem(state: IntegrityState): boolean {
  return (
    state.integrityError ||
    (state.integrity !== null && state.integrity.finalized && !state.integrity.ok)
  );
}

/**
 * Das Ergebnis als Abzeichen — gedacht für die Kopfzeile.
 *
 * Icon UND Text, Farbe allein sagt nichts. Ein Fehler (Abweichung oder
 * Prüfung nicht möglich) ist ein `alert` und bleibt sichtbar, auch wenn die
 * Details eingeklappt sind: Er darf nirgends versteckt sein.
 */
export function IntegrityStatusBadge({ state }: { state: IntegrityState }) {
  const t = useT();
  if (!state.finalized) return null;
  const base =
    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold';
  if (state.integrityError) {
    return (
      <span
        role="alert"
        className={`${base} bg-bedenken-bg border-bedenken-rahmen text-bedenken-text`}
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {t('gobd.integrityFailedBadge')}
      </span>
    );
  }
  if (state.integrity === null) {
    return (
      <span
        role="status"
        className={`${base} border-rahmen bg-flaeche-2 text-leise`}
      >
        <Clock3 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {t('gobd.integrityLoading')}
      </span>
    );
  }
  if (!state.integrity.finalized) return null;
  const ok = state.integrity.ok;
  const Icon = ok ? CheckCircle2 : AlertTriangle;
  const surface = ok
    ? 'bg-beschluss-bg border-beschluss-rahmen text-beschluss-text'
    : 'bg-bedenken-bg border-bedenken-rahmen text-bedenken-text';
  return (
    <span className={`${base} ${surface}`} role={ok ? 'status' : 'alert'}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {ok ? t('gobd.integrityOk') : t('gobd.integrityMismatch')}
    </span>
  );
}

/**
 * Integrität, Aufbewahrung und Verlauf EINER festgeschriebenen Rechnung (GoBD).
 *
 * Alles rein lesend und EINGEKLAPPT (`<details>`): Das Ergebnis steht als
 * Abzeichen in der Kopfzeile, die Karte hält nur noch Details und Verlauf.
 * Bei einem Fehlerzustand ist sie dagegen von Anfang an aufgeklappt — eine
 * Abweichung wird nicht hinter einem Pfeil versteckt.
 *
 * Ohne `state` lädt die Karte selbst und zeigt das Abzeichen in ihrer
 * Überschriftenzeile (eigenständige Nutzung); mit `state` und
 * `showBadge={false}` übernimmt die Kopfzeile des Aufrufers das Abzeichen.
 */
export function InvoiceIntegrity(props: {
  invoiceId: string;
  finalized: boolean;
  retentionUntil?: string | null;
  state?: IntegrityState;
  showBadge?: boolean;
}) {
  // Zwei Pfade statt eines bedingten Hook-Aufrufs: Mit `state` darf die Karte
  // nicht noch einmal laden.
  return props.state ? (
    <IntegrityCard
      state={props.state}
      retentionUntil={props.retentionUntil}
      finalized={props.finalized}
      showBadge={props.showBadge ?? true}
    />
  ) : (
    <IntegrityCardSelfLoading {...props} />
  );
}

function IntegrityCardSelfLoading({
  invoiceId,
  finalized,
  retentionUntil,
  showBadge = true,
}: {
  invoiceId: string;
  finalized: boolean;
  retentionUntil?: string | null;
  showBadge?: boolean;
}) {
  const state = useInvoiceIntegrity(invoiceId, finalized);
  return (
    <IntegrityCard
      state={state}
      retentionUntil={retentionUntil}
      finalized={finalized}
      showBadge={showBadge}
    />
  );
}

function IntegrityCard({
  state: current,
  finalized,
  retentionUntil,
  showBadge,
}: {
  state: IntegrityState;
  finalized: boolean;
  retentionUntil?: string | null;
  showBadge: boolean;
}) {
  const t = useT();
  const { integrity, history, historyError } = current;
  const problem = isProblem(current);

  return (
    <Card className="mt-6 p-4 sm:p-6">
      <details open={problem || undefined} className="group">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-2 rounded-md text-lg font-semibold text-text [&::-webkit-details-marker]:hidden">
          <ChevronRight
            className="h-4 w-4 shrink-0 text-leise transition-transform group-open:rotate-90"
            aria-hidden="true"
          />
          <span>{t('gobd.integrityTitle')}</span>
          {showBadge && <IntegrityStatusBadge state={current} />}
        </summary>

        <div className="mt-4">
          {finalized && integrity !== null && (
            <IntegrityDetails result={integrity} />
          )}
          {finalized && current.integrityError && (
            <p className="mb-4 text-sm text-leise">{t('gobd.integrityFailed')}</p>
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
                      {t('gobd.historyAt', { at: localStamp(entry.at) })} ·{' '}
                      {t('gobd.historyBy', { actor: entry.actor })}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </details>
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

function IntegrityDetails({ result }: { result: IntegrityResult }) {
  const t = useT();
  if (!result.finalized) {
    return <p className="mb-4 text-sm text-leise">{t('gobd.integrityDraft')}</p>;
  }
  const ok = result.ok;
  return (
    <div className="mb-4">
      <p className="text-sm text-leise">
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
        {t('gobd.integrityCheckedAt', { at: localStamp(result.checkedAt) })}
      </p>
    </div>
  );
}
