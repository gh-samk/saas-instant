import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Mail, Pencil, UserPlus } from 'lucide-react';
import { IconButton, Card, Button, ROW_LINK_CLASSES } from '@saas-instant/ui';
import {
  fetchInquiries,
  fetchInstance,
  fetchInvoices,
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

/**
 * DIE EINRICHTUNGSSCHRITTE einer Organisation — der geführte Weg von „gerade
 * angelegt" bis „erste Rechnung".
 *
 * „ERLEDIGT" WIRD AUS DEN VORHANDENEN DATEN ABGELEITET, nicht in einem eigenen
 * Feld abgehakt. Ein Häkchen, das jemand von Hand setzt, widerspräche früher
 * oder später dem, was die Organisation tatsächlich hat (Instanz archiviert,
 * Rechnung gelöscht). Abgeleitet bleibt die Liste von selbst wahr:
 *
 * - Vertrag:  Preisstufe UND Zahlungsweise sind gesetzt. Eines allein reicht
 *             nicht — ohne beides kann der Rechnungsentwurf weder Stufe noch
 *             Zeitraum vorbelegen.
 * - Instanz:  es gibt eine Instanz (gleich in welchem Zustand; eine
 *             archivierte war angelegt, die Aufgabe ist also nicht mehr
 *             „anlegen").
 * - Rechnung: mindestens eine Rechnung, auch ein Entwurf.
 *   (Instanz und Rechnung entfallen bei Anfrage und Demo — sie folgen dem
 *   Pilotbeschluss.)
 * - Stellvertretung: Name oder E-Mail der Stellvertretung stehen im Datensatz.
 *
 * `hasInstance`/`hasInvoice` sind `null`, wenn das Laden scheiterte: Dann ist
 * der Schritt UNBEKANNT und wird ausgelassen, statt einen Knopf für etwas zu
 * zeigen, das vielleicht längst erledigt ist.
 */
export type SetupStepId = 'contract' | 'instance' | 'invoice' | 'deputy';

export interface SetupStep {
  id: SetupStepId;
  done: boolean;
}

export function setupSteps(
  company: Pick<
    Company,
    'priceTier' | 'paymentInterval' | 'deputyName' | 'deputyEmail'
  > &
    Partial<Pick<Company, 'status'>>,
  hasInstance: boolean | null,
  hasInvoice: boolean | null,
): SetupStep[] {
  const steps: SetupStep[] = [
    {
      id: 'contract',
      done:
        (company.priceTier ?? '').trim() !== '' &&
        company.paymentInterval !== null,
    },
  ];
  // Vor dem Pilotbeschluss gibt es weder Instanz noch Rechnung anzulegen
  // (der Reiter „Instanz" sagt es genauso): Die Schritte kämen zu früh.
  const early = company.status === 'inquiry' || company.status === 'demo';
  if (!early && hasInstance !== null) steps.push({ id: 'instance', done: hasInstance });
  if (!early && hasInvoice !== null) steps.push({ id: 'invoice', done: hasInvoice });
  steps.push({
    id: 'deputy',
    done:
      (company.deputyName ?? '').trim() !== '' ||
      (company.deputyEmail ?? '').trim() !== '',
  });
  return steps;
}

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
  half_yearly: t('components.companyOverview.halfYearly'),
  monthly: t('components.companyOverview.monthly'),
};

/** Titel, Erklärung und Knopf je Schritt (Schlüssel im Wörterbuch). */
const STEP_TEXT: Record<
  SetupStepId,
  { title: string; hint: string; button: string; done: string }
> = {
  contract: {
    title: t('components.companyOverview.stepContractTitle'),
    hint: t('components.companyOverview.stepContractHint'),
    button: t('components.companyOverview.stepContractButton'),
    done: t('components.companyOverview.stepContractDone'),
  },
  instance: {
    title: t('components.companyOverview.stepInstanceTitle'),
    hint: t('components.companyOverview.stepInstanceHint'),
    button: t('components.companyOverview.stepInstanceButton'),
    done: t('components.companyOverview.stepInstanceDone'),
  },
  invoice: {
    title: t('components.companyOverview.stepInvoiceTitle'),
    hint: t('components.companyOverview.stepInvoiceHint'),
    button: t('components.companyOverview.stepInvoiceButton'),
    done: t('components.companyOverview.stepInvoiceDone'),
  },
  deputy: {
    title: t('components.companyOverview.stepDeputyTitle'),
    hint: t('components.companyOverview.stepDeputyHint'),
    button: t('components.companyOverview.stepDeputyButton'),
    done: t('components.companyOverview.stepDeputyDone'),
  },
};

export function CompanyOverview({
  company,
  onContactEdit,
  onDeputy,
  onContract,
  onInstance,
  onInvoice,
}: {
  company: Company;
  onContactEdit: () => void;
  onDeputy: () => void;
  /** „Vertrag festlegen": Reiter wechseln und das Formular der Vertragsdaten öffnen. */
  onContract: () => void;
  /** „Instanz anlegen": Reiter „Instanz" mit geöffnetem Anlegen-Dialog. */
  onInstance: () => void;
  /** „Erste Rechnung anlegen": direkt in den neuen Entwurf. */
  onInvoice: () => void;
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

  // INSTANZ UND RECHNUNGEN, nur um die Schritte abzuhaken. `undefined` = lädt,
  // `null` = Laden gescheitert (Schritt unbekannt, wird ausgelassen).
  const [hasInstance, setHasInstance] = useState<boolean | null | undefined>(
    undefined,
  );
  const [hasInvoice, setHasInvoice] = useState<boolean | null | undefined>(
    undefined,
  );
  useEffect(() => {
    let aborted = false;
    setHasInstance(undefined);
    setHasInvoice(undefined);
    fetchInstance(company.id)
      .then((instance) => {
        if (!aborted) setHasInstance(instance != null);
      })
      .catch(() => {
        if (!aborted) setHasInstance(null);
      });
    fetchInvoices(company.id)
      .then((invoices) => {
        if (!aborted) setHasInvoice(invoices.length > 0);
      })
      .catch(() => {
        if (!aborted) setHasInvoice(null);
      });
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

  // KENNZAHLEN OHNE WERT FEHLEN, statt als „—" zu stehen. Eine frisch angelegte
  // Organisation hätte sonst sechs leere Kacheln, die nur sagen, was alles
  // nicht da ist — das sagt die Schrittliste besser, und mit Knopf.
  const metrics: { label: string; value: string }[] = [
    { label: t('components.companyOverview.label'), value: o.priceTier ?? '' },
    {
      label: t('components.companyOverview.label2'),
      value: o.paymentInterval ? (PAYMENT_INTERVAL_LABEL[o.paymentInterval] ?? '') : '',
    },
    {
      label: t('components.companyOverview.label3'),
      value: o.pilotDecisionDate ? formatDate(o.pilotDecisionDate) : '',
    },
    {
      label: t('components.companyOverview.label4'),
      value: o.reviewDueDate ? formatDate(o.reviewDueDate) : '',
    },
    {
      label: t('components.companyOverview.label5'),
      value: o.instanceStartDate ? formatDate(o.instanceStartDate) : '',
    },
    { label: t('components.companyOverview.label6'), value: requestedKinds },
  ].filter((m) => m.value.trim() !== '');
  const hasInquiries = inquiries !== null && inquiries.length > 0;

  // Die Schrittliste gibt es nur für lebende Organisationen: Bei einer
  // beendeten oder ruhenden wäre „Instanz anlegen" eine Aufforderung ins Leere.
  const guided = o.status !== 'ended' && o.status !== 'dormant';
  const loadingStepData = hasInstance === undefined || hasInvoice === undefined;
  const steps = guided
    ? setupSteps(o, hasInstance ?? null, hasInvoice ?? null)
    : [];
  const openSteps = steps.filter((s) => !s.done);
  const doneSteps = steps.filter((s) => s.done);
  const stepAction: Record<SetupStepId, () => void> = {
    contract: onContract,
    instance: onInstance,
    invoice: onInvoice,
    deputy: onDeputy,
  };
  const loading = tasks === null || (guided && loadingStepData);

  return (
    <>
      {(metrics.length > 0 || hasInquiries) && (
        <Card className="mt-4 p-[18px]">
          {metrics.length > 0 && (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
              {/* `abweichenderBetrag` steht bewusst NICHT als Rückfall hier: Er
                  gehört zu den Zahlungsdaten und liegt hinter dem zweiten
                  Faktor (`ZahlungsdatenKarte`). Ihn im Überblick zu zeigen
                  führte den Schutz vor. */}
              {metrics.map((m) => (
                <MetricValue key={m.label} label={m.label} value={m.value} />
              ))}
              {/* TEILHABENDE STEHT HIER NICHT. Das Design zeigt den Wert; das
                  Backend kennt ihn nur als MESSWERT der laufenden Instanz
                  (`Kennzahl.aktivePersonen`), nicht als Vertragsangabe. Ihn
                  hier zu zeigen hiesse, eine Messung als Vereinbarung
                  auszugeben — und ohne Instanz stünde ohnehin nichts da. Der
                  gemessene Wert steht im Reiter „Instanz", wo er hingehört. */}
            </dl>
          )}
          {hasInquiries && (
            <ul
              className={`flex flex-col gap-1 text-[13px] text-leise ${
                metrics.length > 0 ? 'mt-4 border-t border-rahmen-leise pt-3' : ''
              }`}
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
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="min-w-0 p-[18px]">
          <h2 className="mb-3 text-[17px] font-semibold text-text">
            {t('components.companyOverview.heading')}</h2>
          {loading ? (
            <p className="text-sm text-still">{t('components.companyOverview.text3')}</p>
          ) : (
            <>
              {/* OFFENE SCHRITTE ZUERST, jeder mit dem Knopf, der dorthin
                  führt, wo er erledigt wird. Der erste ist der Hauptknopf —
                  die Reihenfolge ist der Weg Vertrag, Instanz, Rechnung. */}
              {openSteps.length > 0 && (
                <ol className="flex flex-col divide-y divide-rahmen-leise">
                  {openSteps.map((step, i) => (
                    <li
                      key={step.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0"
                    >
                      <div className="min-w-0 flex-1 basis-48">
                        <p className="text-sm font-semibold text-text break-words">
                          {STEP_TEXT[step.id].title}
                        </p>
                        <p className="text-[13px] text-leise break-words">
                          {STEP_TEXT[step.id].hint}
                        </p>
                      </div>
                      <Button
                        variant={i === 0 ? 'primary' : 'secondary'}
                        onClick={stepAction[step.id]}
                      >
                        {STEP_TEXT[step.id].button}
                      </Button>
                    </li>
                  ))}
                </ol>
              )}

              {/* ERLEDIGTES BLEIBT, ABER IM HINTERGRUND: eingeklappt und eine
                  Zeile hoch. Wer wissen will, was schon steht, klappt auf;
                  wer arbeitet, wird nicht aufgehalten. */}
              {doneSteps.length > 0 && (
                <details
                  className={`group text-sm ${
                    openSteps.length > 0 ? 'mt-3 border-t border-rahmen-leise pt-3' : ''
                  }`}
                >
                  <summary className="flex min-h-11 cursor-pointer items-center gap-2 rounded text-[13px] sm:min-h-0 text-leise list-none [&::-webkit-details-marker]:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fokus">
                    <Check className="h-4 w-4 shrink-0 text-erfolg-text" aria-hidden="true" />
                    {t('components.companyOverview.stepsDone', {
                      done: doneSteps.length,
                      total: steps.length,
                    })}
                  </summary>
                  <ul className="mt-2 flex flex-col gap-1.5 pl-6 text-[13px] text-leise">
                    {doneSteps.map((step) => (
                      <li key={step.id} className="flex items-center gap-2">
                        <Check className="h-3.5 w-3.5 shrink-0 text-erfolg-text" aria-hidden="true" />
                        <span className="min-w-0 break-words">{STEP_TEXT[step.id].done}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {tasks.length > 0 && (
                <ul
                  className={`flex flex-col divide-y divide-rahmen-leise ${
                    steps.length > 0 ? 'mt-3 border-t border-rahmen-leise pt-3' : ''
                  }`}
                >
                  {tasks.map((a, i) => (
                    <li
                      key={`${a.kind}-${i}`}
                      className="flex flex-wrap items-center gap-3 py-2.5 first:pt-0 last:pb-0"
                    >
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${TASK_URGENCY_POINT[a.urgency]}`}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 basis-40 break-words text-sm text-text">
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

              {/* DER LEERZUSTAND NUR, WENN WIRKLICH NICHTS OFFEN IST: weder
                  ein Einrichtungsschritt noch eine Aufgabe. Stand er vorher
                  neben drei fehlenden Schritten, log er. */}
              {openSteps.length === 0 && tasks.length === 0 && (
                <p className={`text-sm text-still ${doneSteps.length > 0 ? 'mt-3' : ''}`}>
                  {t('components.companyOverview.text4')}</p>
              )}
            </>
          )}
        </Card>

        <Card className="min-w-0 p-[18px]">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-[17px] font-semibold text-text">
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
