import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, Pencil, UserPlus } from 'lucide-react';
import { IconButton, Card, Button, ROW_LINK_CLASSES } from '@saas-instant/ui';
import {
  fetchInquiries,
  fetchTasks,
  type Task,
  type Company,
  type CompanyInquiry,
} from '../lib/api';
import { TASK_URGENCY_POINT } from '../lib/tasks';
import { formatDate } from '../utils/date';
import { t, useT } from '../i18n';

/**
 * Der Reiter „Überblick" — die Antwort auf „wo stehen wir mit denen?".
 *
 * DREI DINGE, MEHR NICHT: die Eckdaten des Vertrags als Raster, was als
 * Nächstes ansteht, und wer der Kontakt ist. Alles andere hat einen eigenen
 * Reiter. Ein Überblick, der alles zeigt, ist keiner.
 *
 * DIE NÄCHSTEN SCHRITTE WERDEN NICHT ERFUNDEN. Sie sind dieselben Aufgaben,
 * die auch auf „Heute" stehen — nur auf diese Organisation eingeschränkt. Eine
 * zweite, hier gerechnete Liste liefe der ersten davon, und dann stünde auf
 * zwei Seiten Verschiedenes über denselben Sachverhalt.
 */

/** Ein Wert im Kennzahlenraster. */
function MetricValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-still">
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-[15px] text-text ziffern-tabellarisch">
        {value}
      </dd>
    </div>
  );
}

/** Was auf eine Anfrage hin passierte – in Worten der Betreiberin. */
const OUTCOME_LABEL: Record<string, string> = {
  credentials_sent: t('components.companyOverview.credentialsSent'),
  confirmation_sent: t('components.companyOverview.confirmationSent'),
  already_triggered: t('components.companyOverview.alreadyTriggered'),
  quota_exhausted: t('components.companyOverview.quotaExhausted'),
  send_failed: t('components.companyOverview.sendFailed'),
};

function kindLabel(kind: CompanyInquiry['kind']): string {
  return kind === 'demo' ? t('components.companyOverview.text') : t('components.companyOverview.text2');
}

const PAYMENT_INTERVAL_LABEL: Record<string, string> = {
  yearly: t('components.companyOverview.yearly'),
  monthly: 'monthly',
};

export function CompanyOverview({
  company,
  onContactEdit,
  onDeputy,
}: {
  company: Company;
  onContactEdit: () => void;
  onDeputy: () => void;
}) {
  const t = useT();
  const [tasks, setTasks] = useState<Task[] | null>(null);

  useEffect(() => {
    let aborted = false;
    fetchTasks()
      .then((response) => {
        if (aborted) return;
        setTasks(
          response.tasks.filter(
            (a) => a.company?.id === company.id,
          ),
        );
      })
      // STILL. Die nächsten Schritte sind eine Zugabe; ein Fehlerbanner
      // dafür verdeckte die Eckdaten, die auch ohne sie stimmen.
      .catch(() => setTasks([]));
    return () => {
      aborted = true;
    };
  }, [company.id]);

  // WAS ANGEFRAGT WURDE, eigens geladen: Es gehört nicht zur
  // Organisationsantwort, die nach jedem Bearbeiten ersetzt wird.
  const [inquiries, setInquiries] = useState<CompanyInquiry[] | null>(null);
  useEffect(() => {
    let aborted = false;
    fetchInquiries(company.id)
      .then((response) => {
        if (!aborted) setInquiries(response.inquiries);
      })
      // STILL, wie bei den nächsten Schritten: eine Zugabe zum Überblick.
      .catch(() => setInquiries([]));
    return () => {
      aborted = true;
    };
  }, [company.id]);

  const requestedKinds = [
    ...new Set((inquiries ?? []).map((a) => kindLabel(a.kind))),
  ].join(' · ');

  const o = company;
  const contactInitials = (o.contactName ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <>
      <Card className="mt-4 p-[18px]">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
          {/* `abweichenderBetrag` steht bewusst NICHT als Rückfall hier: Er
              gehört zu den Zahlungsdaten und liegt hinter dem zweiten Faktor
              (`ZahlungsdatenKarte`). Ihn im Überblick zu zeigen führte den
              Schutz vor. */}
          <MetricValue label={t('components.companyOverview.label')} value={o.priceTier ?? '—'} />
          <MetricValue
            label={t('components.companyOverview.label2')}
            value={
              o.paymentInterval ? PAYMENT_INTERVAL_LABEL[o.paymentInterval] : '—'
            }
          />
          <MetricValue
            label={t('components.companyOverview.label3')}
            value={
              o.pilotDecisionDate ? formatDate(o.pilotDecisionDate) : '—'
            }
          />
          <MetricValue
            label={t('components.companyOverview.label4')}
            value={
              o.reviewDueDate
                ? formatDate(o.reviewDueDate)
                : '—'
            }
          />
          <MetricValue
            label={t('components.companyOverview.label5')}
            value={o.instanceStartDate ? formatDate(o.instanceStartDate) : '—'}
          />
          <MetricValue label={t('components.companyOverview.label6')} value={requestedKinds || '—'} />
          {/* TEILHABENDE STEHT HIER NICHT. Das Design zeigt den Wert; das
              Backend kennt ihn nur als MESSWERT der laufenden Instanz
              (`Kennzahl.aktivePersonen`), nicht als Vertragsangabe. Ihn hier
              zu zeigen hiesse, eine Messung als Vereinbarung auszugeben —
              und ohne Instanz stünde ohnehin nichts da. Der gemessene Wert
              steht im Reiter „Instanz", wo er hingehört. */}
        </dl>
        {inquiries && inquiries.length > 0 && (
          <ul
            className="mt-4 flex flex-col gap-1 border-t border-rahmen-leise pt-3 text-[13px] text-leise"
            aria-label={t('components.companyOverview.ariaLabel')}
          >
            {inquiries.map((a, i) => (
              <li key={`${a.kind}-${i}`} className="flex flex-wrap gap-x-2">
                <span className="font-semibold text-text">{kindLabel(a.kind)}</span>
                <span className="ziffern-tabellarisch">
                  {new Date(a.receivedAt).toLocaleString('de-DE', {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })}
                </span>
                <span>
                  ·{' '}
                  {a.outcome
                    ? OUTCOME_LABEL[a.outcome]
                    : t('components.companyOverview.label7')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="p-[18px]">
          <h2 className="mb-3 font-serif text-[17px] font-bold text-text">
            {t('components.companyOverview.heading')}</h2>
          {tasks === null ? (
            <p className="text-sm text-still">{t('components.companyOverview.text3')}</p>
          ) : tasks.length === 0 ? (
            <p className="text-sm text-still">
              {t('components.companyOverview.text4')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-rahmen-leise">
              {tasks.map((a, i) => (
                <li
                  key={`${a.kind}-${i}`}
                  className="flex flex-wrap items-center gap-3 py-2.5 first:pt-0 last:pb-0"
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${TASK_URGENCY_POINT[a.urgency]}`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-text">
                    {a.title}
                  </span>
                  <span className="shrink-0 text-[13px] text-still ziffern-tabellarisch">
                    {formatDate(a.dueAt)}
                  </span>
                  <Link to={a.action.target} className={ROW_LINK_CLASSES}>
                    {a.action.label}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-[18px]">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="font-serif text-[17px] font-bold text-text">
              {t('components.companyOverview.heading2')}</h2>
            <IconButton
              Icon={Pencil}
              label={t('components.companyOverview.label8')}
              size="small"
              onClick={onContactEdit}
            />
          </div>

          {o.contactName || o.contactEmail ? (
            <div className="flex items-center gap-3">
              <span
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primaer-soft text-[13px] font-bold text-primaer-softtext"
                aria-hidden="true"
              >
                {contactInitials || '—'}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-text">
                  {o.contactName ?? t('components.companyOverview.text5')}
                </p>
                <p className="truncate text-[13px] text-leise">
                  {[o.contactRole, o.contactEmail]
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </p>
              </div>
              {o.contactEmail && (
                <IconButton
                  Icon={Mail}
                  label={t('components.companyOverview.label9', { contactEmail: o.contactEmail })}
                  size="small"
                  onClick={() => {
                    window.location.href = `mailto:${o.contactEmail ?? ''}`;
                  }}
                />
              )}
            </div>
          ) : (
            <p className="text-sm text-still">{t('components.companyOverview.text6')}</p>
          )}

          <div className="mt-3 flex items-center justify-between gap-3 border-t border-rahmen-leise pt-3">
            <span className="flex items-center gap-2 text-[13px] text-leise">
              <UserPlus className="h-4 w-4 text-still" aria-hidden="true" />
              {o.deputyName ?? t('components.companyOverview.label10')}
            </span>
            {!o.deputyName && (
              <Button variant="secondary" onClick={onDeputy}>
                {t('components.companyOverview.button')}</Button>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
